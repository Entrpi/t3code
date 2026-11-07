import {
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { v2ThreadId } from "./orchestrationV2TestFixtures.ts";
import { rewindLastingEffects } from "./rewindEffects.ts";

let next = 0;
function base() {
  return {
    id: TurnItemId.make(`item-${(next += 1)}`),
    threadId: v2ThreadId,
    runId: RunId.make("run-1"),
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: next,
    status: "completed",
    title: null,
    startedAt: null,
    completedAt: null,
    updatedAt: DateTime.makeUnsafe("2026-11-06T00:00:00.000Z"),
  } as const;
}

const command = (input: string): OrchestrationV2TurnItem => ({
  ...base(),
  type: "command_execution",
  input,
  exitCode: 0,
});
const patch = (
  paths: ReadonlyArray<string>,
  status: "completed" | "failed" = "completed",
): OrchestrationV2TurnItem => ({
  ...base(),
  status,
  type: "file_change",
  fileName: paths[0]!,
  changes: paths.map((path) => ({ path, operation: "update" })),
});
const tool = (toolName: string): OrchestrationV2TurnItem =>
  ({ ...base(), type: "dynamic_tool", toolName, input: {} }) as OrchestrationV2TurnItem;

describe("rewindLastingEffects", () => {
  it.each([
    [[command("vp test run"), command("cat a.ts"), patch(["/repo/src/a.ts"])], []],
    [
      [command("git add . && git commit -m wip"), command("git -C repo commit --amend")],
      ["Git commits, which stay in git history"],
    ],
    [[command("git push origin HEAD")], ["A push to a remote"]],
    [
      [
        command("vp test run && git push && git branch -a && git worktree list"),
        command("git branch wip"),
      ],
      ["A push to a remote", "1 command the app can't check: git branch wip"],
    ],
    [
      [
        command("npm run deploy"),
        command("bash -lc 'make install && ./scripts/release.sh'"),
        command("cat a.ts | grep b && pnpm run build"),
        command("npm run deploy"),
      ],
      ["3 commands the app can't check: npm run deploy, make install, ./scripts/release.sh"],
    ],
    [
      [
        command("echo hi > /tmp/out.txt && rm -rf ~/cache"),
        command("rm -rf dist && mkdir -p build 2>&1"),
        command("cd /tmp && rm -rf build"),
      ],
      ["3 commands the app can't check: echo hi > /tmp/out.txt, rm -rf ~/cache, cd /tmp"],
    ],
    [[command("gh pr create --fill"), command("gh pr view 12")], ["GitHub changes made with gh"]],
    [[command("pnpm add zod"), command("pip install requests")], ["Package installs or removals"]],
    [
      [patch(["/repo/a.ts", "/tmp/notes.md"]), patch(["/etc/hosts"], "failed")],
      ["Changes to files outside the project: /tmp/notes.md"],
    ],
    [
      [
        patch(["src/a.ts", "../sibling.ts"]),
        command("echo x > ../other/x.txt && touch src/../b.ts"),
        command("touch ../../packages/lib/b.ts && cd .. && ls"),
      ],
      [
        "Changes to files outside the project: /sibling.ts",
        "3 commands the app can't check: echo x > ../other/x.txt, touch ../../packages/lib/b.ts, cd ..",
      ],
    ],
    [
      [tool("mcp__github__create_issue"), tool("mcp__t3-code__t3_thread_read"), tool("Read")],
      ["Tool calls that may have acted outside this thread: create_issue"],
    ],
  ] as const)("lists what a rewind cannot undo: %#", (items, effects) => {
    expect(rewindLastingEffects(items, "/repo")).toEqual(effects);
  });

  it("names threads and subagents with their own thread that the turn started", () => {
    const instance = ProviderInstanceId.make("codex");
    const subagent = (childThreadId: ThreadId | null): OrchestrationV2TurnItem => ({
      ...base(),
      type: "subagent",
      subagentId: NodeId.make(`node-${next}`),
      origin: "app_owned",
      driver: ProviderDriverKind.make("codex"),
      providerInstanceId: instance,
      childThreadId,
      prompt: "check",
      result: null,
    });
    const started: ReadonlyArray<OrchestrationV2TurnItem> = [
      {
        ...base(),
        type: "thread_created",
        targetThreadId: ThreadId.make("thread-a"),
        targetRunId: null,
        targetProviderInstanceId: instance,
        targetModel: "gpt",
      },
      subagent(ThreadId.make("thread-b")),
      subagent(null),
    ];
    expect(rewindLastingEffects(started, "/repo")).toEqual([
      "2 threads or subagents it started, which keep their own history",
    ]);
  });
});
