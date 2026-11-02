import { describe, expect, it } from "vite-plus/test";

import { ThreadId, TurnItemId, type OrchestrationV2TurnItem } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import type { FileActionKind, WorkEntryCommandEffects } from "./fileActions.ts";
import {
  resolveWorkEntryToolPresentation,
  summarizeToolGroup,
  toolItemForDisplay,
  type WorkLogPresentationEntry,
  workEntryIndicatesToolFailure,
  workEntryDisplayIndicatesToolFailure,
} from "./presentation.js";

function commandItem(
  fields: Partial<Extract<OrchestrationV2TurnItem, { type: "command_execution" }>> = {},
): OrchestrationV2TurnItem {
  return {
    id: TurnItemId.make("command"),
    threadId: ThreadId.make("thread"),
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status: "completed",
    title: null,
    startedAt: null,
    completedAt: null,
    updatedAt: DateTime.makeUnsafe("2026-09-08T00:00:00.000Z"),
    type: "command_execution",
    input: 'rg "command not found"',
    ...fields,
  };
}

describe("workEntryIndicatesToolFailure", () => {
  const base = {
    id: "w1",
    createdAt: "2026-01-01T00:00:00.000Z",
    label: "Read",
  };

  it.each([
    [{ exitCode: 2 }, true],
    [{ output: "sh: missing-command: command not found" }, true],
    [{ output: `${"x".repeat(32_768)} command not found` }, false],
  ] as const)(
    "preserves command failure state after removing displayed output: %j",
    (fields, failed) => {
      const structuredPayload = commandItem(fields);
      const entry: WorkLogPresentationEntry = {
        ...base,
        tone: "tool",
        itemType: "command_execution",
        toolLifecycleStatus: "completed",
        structuredPayload,
      };
      expect(workEntryDisplayIndicatesToolFailure(entry)).toBe(failed);
      expect(JSON.stringify(toolItemForDisplay(structuredPayload))).not.toContain('"output":');
    },
  );

  it.each([
    "logs/app.log:12: Error: ENOENT: no such file or directory",
    "fixtures/ci.txt:3: Process exited with exit code 2",
  ])("trusts a zero exit code over failure text in the output and command: %s", (output) => {
    const entry: WorkLogPresentationEntry = {
      ...base,
      tone: "tool",
      itemType: "command_execution",
      toolLifecycleStatus: "completed",
      command: 'rg -n "ENOENT|exit code" logs fixtures',
      structuredPayload: commandItem({ output, exitCode: 0, outputIndicatesFailure: true }),
    };
    expect(workEntryIndicatesToolFailure(entry)).toBe(false);
    expect(workEntryDisplayIndicatesToolFailure(entry)).toBe(false);
  });

  it("ignores failure phrases in reasoning text", () => {
    const entry: WorkLogPresentationEntry = {
      ...base,
      label: "Thinking",
      tone: "thinking",
      itemType: "reasoning",
      toolLifecycleStatus: "completed",
      detail: "That exit code 2 is just from listing the deleted directory, which is expected.",
    };
    expect(workEntryIndicatesToolFailure(entry)).toBe(false);
    expect(workEntryDisplayIndicatesToolFailure(entry)).toBe(false);
  });

  it("does not treat error text in a command as rendered failure", () => {
    const entry = {
      ...base,
      label: "Ran command",
      tone: "tool",
      toolLifecycleStatus: "completed",
      command: 'rg "file not found"',
      detail: "Found 3 matches",
    } satisfies WorkLogPresentationEntry;

    expect(workEntryDisplayIndicatesToolFailure(entry)).toBe(false);

    expect(workEntryIndicatesToolFailure(entry)).toBe(true);
    expect(workEntryDisplayIndicatesToolFailure({ ...entry, detail: "File not found" })).toBe(true);
  });
});

describe("resolveWorkEntryToolPresentation", () => {
  it("shows returned MCP errors as failures even in the live activity row", () => {
    const entry: WorkLogPresentationEntry = {
      id: "clone",
      createdAt: "2026-09-19T00:00:00.000Z",
      tone: "tool",
      label: "T3-code.t3_project_clone",
      toolLifecycleStatus: "inProgress",
      itemType: "dynamic_tool",
      toolData: { output: { isError: true } },
    };
    expect(resolveWorkEntryToolPresentation(entry)?.displayName).toBe(
      "Failed to clone a repository",
    );
    expect(workEntryDisplayIndicatesToolFailure(entry)).toBe(true);
    const childFailure = {
      ...entry,
      label: "T3-code.task_status",
      toolLifecycleStatus: "completed" as const,
      toolData: { output: { taskId: "child", status: "failed", summary: "command not found" } },
    };
    expect(workEntryDisplayIndicatesToolFailure(childFailure)).toBe(false);
  });
  it.each([
    "mcp__t3-code__preview_click",
    "mcp__t3_code__preview_click",
    "mcp__t3code__preview_click",
    "T3-code.preview_click",
    "t3-code · preview_click completed",
    "t3_code/preview_click",
    "preview_click",
  ])("recognizes browser tool names across providers: %s", (label) => {
    expect(resolveWorkEntryToolPresentation({ label })).toEqual({
      displayName: "Clicking in the preview browser",
      icon: "browser",
    });
  });

  it("uses structured MCP identity when the provider supplies a custom title", () => {
    expect(
      resolveWorkEntryToolPresentation({
        label: "Tool call complete",
        toolTitle: "Inspect the current page",
        toolData: { server: "t3-code", tool: "preview_snapshot", result: { title: "Example" } },
      }),
    ).toEqual({ displayName: "Taking a snapshot of the preview page", icon: "browser" });
  });

  it("uses the summary's state only when the provider omitted a lifecycle status", () => {
    const entry = { label: "T3-code.preview_click" };
    expect(resolveWorkEntryToolPresentation(entry, "inProgress")?.displayName).toBe(
      "Clicking in the preview browser",
    );
    expect(resolveWorkEntryToolPresentation(entry, "completed")?.displayName).toBe(
      "Clicked in the preview browser",
    );
    expect(
      resolveWorkEntryToolPresentation({ ...entry, toolLifecycleStatus: "completed" }, "inProgress")
        ?.displayName,
    ).toBe("Clicked in the preview browser");
    expect(
      resolveWorkEntryToolPresentation({ ...entry, toolLifecycleStatus: "failed" }, "completed")
        ?.displayName,
    ).toBe("Failed to click in the preview browser");
  });

  it.each([
    ["https://github.com/acme/web/pull/7", "PR #7"],
    ["https://gitlab.com/acme/web/-/merge_requests/7", "MR #7"],
  ])("names a linked change request with its host's term (%s)", (url, target) => {
    expect(
      resolveWorkEntryToolPresentation({
        label: "T3-code.link_pull_request",
        toolLifecycleStatus: "completed",
        toolData: { arguments: { url } },
      })?.displayName,
    ).toMatch(new RegExp(` ${target}$`));
  });

  it("does not brand unknown tools or another server's matching tool name", () => {
    for (const label of [
      "mcp__github__preview_click",
      "t3-code.unknown_tool",
      "t3-code.toString",
      "Search files",
    ]) {
      expect(resolveWorkEntryToolPresentation({ label })).toBeNull();
    }
    expect(
      resolveWorkEntryToolPresentation({
        label: "preview_click",
        toolData: { server: "another-server", tool: "preview_click" },
      }),
    ).toBeNull();
  });
});

describe("summarizeToolGroup", () => {
  let next = 0;
  const entry = (fields: Partial<WorkLogPresentationEntry>): WorkLogPresentationEntry => ({
    id: `e${(next += 1)}`,
    createdAt: "2026-11-02T00:00:00.000Z",
    label: "Tool",
    tone: "tool",
    toolLifecycleStatus: "completed",
    ...fields,
  });
  const file = (kind: FileActionKind, path: string) =>
    entry({
      itemType: "file_change",
      label: `${kind} ${path}`,
      fileAction: { kind, path, exact: true },
    });
  const command = (input: string) => entry({ itemType: "command_execution", command: input });
  const read = (...paths: string[]) =>
    entry({
      itemType: "command_execution",
      command: `cat ${paths.join(" ")}`,
      commandAction: { kind: "read", paths },
    });
  const search = () =>
    entry({
      itemType: "command_execution",
      command: "rg x",
      commandAction: { kind: "search", query: "x" },
    });
  const effects = (
    input: string,
    commits: number,
    files: ReadonlyArray<readonly [FileActionKind, string]> = [],
  ) => {
    const commandEffects: WorkEntryCommandEffects = {
      files: files.map(([kind, path]) => ({ kind, path, exact: true })),
      commits,
      chained: true,
    };
    return entry({ itemType: "command_execution", command: input, commandEffects });
  };
  const commit = () => effects("git add . && git commit -m test", 1);
  const plan = () => entry({ itemType: "todo_list", tone: "info", label: "Tasks 1/3" });
  const thought = () => entry({ itemType: "reasoning", tone: "thinking", detail: "hmm" });

  it.each([
    [
      [read("a.ts"), read("b.ts"), command("vp test run")],
      "Inspected 2 files and ran 1 command",
      3,
    ],
    [[file("create", "a.ts")], "Created 1 file", 1],
    [
      [
        file("create", "a.ts"),
        file("create", "b.ts"),
        file("create", "c.ts"),
        file("delete", "d.ts"),
      ],
      "Created 3 files and deleted 1 file",
      4,
    ],
    [
      [file("edit", "a.ts"), file("delete", "b.ts"), command("vp test run")],
      "Edited 1 file, deleted 1 file, and ran 1 command",
      3,
    ],
    [
      [
        search(),
        read("a.ts", "b.ts"),
        file("move", "c.ts"),
        file("write", "d.ts"),
        plan(),
        command("ls"),
      ],
      "Searched code 1 time, inspected 2 files, moved 1 file, wrote 1 file, updated the plan, and ran 1 command",
      6,
    ],
    [
      [file("edit", "a.ts"), file("edit", "a.ts"), thought(), entry({ label: "Tool call" })],
      "Edited 1 file and used 1 tool",
      3,
    ],
    [[commit()], "Made 1 commit", 1],
    [[commit(), effects("git commit -m a && git commit -m b", 2)], "Made 3 commits", 2],
    [
      [
        read("a.ts"),
        effects("rm -f x && rm -f y && touch z && ls -l z", 0, [
          ["delete", "x"],
          ["delete", "y"],
          ["create", "z"],
        ]),
        command("ls"),
      ],
      "Inspected 1 file, deleted 2 files, created 1 file, and ran 1 command",
      3,
    ],
  ] as const)("names every action in Compact: %#", (entries, summary, steps) => {
    expect(summarizeToolGroup(entries, "compact")).toMatchObject({ summary, steps });
  });

  it("tones file changes, deletions and commits so clients can highlight them", () => {
    expect(
      summarizeToolGroup(
        [file("create", "a.ts"), file("delete", "b.ts"), commit(), command("ls")],
        "compact",
      ).parts,
    ).toEqual([
      { text: "Created 1 file", tone: "file-change" },
      { text: ", " },
      { text: "deleted 1 file", tone: "file-delete" },
      { text: ", " },
      { text: "made 1 commit", tone: "commit" },
      { text: ", and " },
      { text: "ran 1 command" },
    ]);
  });

  it("keeps two categories in Standard, with file verbs and a named plan update", () => {
    expect(
      summarizeToolGroup([file("create", "a.ts"), plan(), read("b.ts"), command("ls")]).summary,
    ).toBe("Created 1 file, ran 1 command, and performed 2 other actions");
    expect(summarizeToolGroup([plan(), read("b.ts")]).summary).toBe(
      "Updated the plan and read 1 file",
    );
    expect(summarizeToolGroup([read("a.ts"), read("b.ts"), commit(), command("ls")]).summary).toBe(
      "Made 1 commit, ran 1 command, and performed 2 other actions",
    );
  });
});
