import * as DateTime from "effect/DateTime";
import {
  EnvironmentId,
  NodeId,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { scopeThreadRef, scopedThreadKey } from "../environment/scoped.ts";
import { presentThreadShell, type EnvironmentThreadShell } from "./models.ts";
import { v2ThreadShell } from "./orchestrationV2TestFixtures.ts";
import {
  activeSubagentCount,
  isListedThread,
  subsessionDescendants,
  subsessionTree,
  threadSubsessionState,
  type SubsessionNode,
} from "./subsessions.ts";

describe("subsessions", () => {
  const environmentId = EnvironmentId.make("local");
  const parent = ThreadId.make("parent");
  const child = (
    id: string,
    overrides: Partial<OrchestrationV2ThreadShell> = {},
  ): EnvironmentThreadShell =>
    presentThreadShell(environmentId, {
      ...v2ThreadShell,
      id: ThreadId.make(id),
      title: id,
      lineage: { parentThreadId: parent, relationshipToParent: "subagent", rootThreadId: parent },
      creationSource: "mcp",
      latestUserMessageAt: null,
      ...overrides,
    });
  const at = (minute: number) =>
    DateTime.makeUnsafe(`2026-11-04T10:${String(minute).padStart(2, "0")}:00.000Z`);

  it("counts a session's own subagents working in its turn or its background work", () => {
    expect(
      activeSubagentCount({
        workingSubagents: [
          { threadId: ThreadId.make("a"), title: null, origin: "provider_native" },
          { threadId: ThreadId.make("delegated"), title: null, origin: "app_owned" },
        ],
        pendingBackgroundTasks: [
          // The same agent, still running after the turn: counted once.
          { kind: "subagent", taskId: "t1", childThreadId: ThreadId.make("a") },
          // Providers report their own background agents without an origin.
          { kind: "subagent", taskId: "t2" },
          { kind: "subagent", taskId: "t3", origin: "app_owned" },
          { kind: "command", taskId: "t4" },
        ],
      }),
    ).toBe(2);
  });

  it("lists a thread's open subsessions once, the shell's copy first, most recent first", () => {
    const rows = subsessionTree(
      parent,
      [child("fresh", { title: "from the shell", latestUserMessageAt: at(9) })],
      [
        child("fresh", { title: "from the family read" }),
        child("older", { latestUserMessageAt: at(1) }),
        child("newer", { latestUserMessageAt: at(5) }),
        child("settled", { settledOverride: "settled" }),
        child("archived", { archivedAt: at(2) }),
        child("native", { creationSource: "provider" }),
        child("elsewhere", {
          lineage: {
            parentThreadId: ThreadId.make("other"),
            relationshipToParent: "subagent",
            rootThreadId: parent,
          },
        }),
      ],
    );
    expect(rows.map((row) => row.thread.title)).toEqual(["from the shell", "newer", "older"]);
  });

  it("nests subsessions under their own parent and rolls up what a collapsed row hides", () => {
    const under = (
      parentId: string,
      id: string,
      overrides: Partial<OrchestrationV2ThreadShell> = {},
    ) =>
      child(id, {
        lineage: {
          parentThreadId: ThreadId.make(parentId),
          relationshipToParent: "subagent",
          rootThreadId: parent,
        },
        ...overrides,
      });
    const tree = subsessionTree(
      parent,
      [],
      [
        child("middle"),
        under("middle", "grandchild"),
        { ...under("grandchild", "waiting"), hasPendingApprovals: true },
        child("settled", { settledOverride: "settled" }),
        // A settled subsession's open children stay with it in the Settled section.
        under("settled", "with settled"),
        // A cycle ends the walk instead of looping.
        under("loop", "loop"),
      ],
    );
    const shape = (nodes: ReadonlyArray<SubsessionNode>): unknown =>
      nodes.map((node) => [node.thread.id, node.descendantState, shape(node.children)]);
    expect(shape(tree)).toEqual([
      ["middle", "waiting", [["grandchild", "waiting", [["waiting", null, []]]]]],
    ]);
  });

  it("groups the shell's subsessions under each subsession ancestor's key", () => {
    const byAncestor = subsessionDescendants([
      child("session"),
      child("nested", {
        lineage: {
          parentThreadId: ThreadId.make("session"),
          relationshipToParent: "subagent",
          rootThreadId: parent,
        },
      }),
      child("native", { creationSource: "provider" }),
      presentThreadShell(environmentId, { ...v2ThreadShell, id: parent }),
    ]);
    const key = (id: string) => scopedThreadKey(scopeThreadRef(environmentId, ThreadId.make(id)));
    expect([...byAncestor].map(([key, rows]) => [key, rows.map((row) => row.id)])).toEqual([
      [key("parent"), ["session", "nested"]],
      [key("session"), ["nested"]],
    ]);
  });

  it("lists settled subsessions with threads and keeps open ones under their parent", () => {
    expect(
      [child("open"), child("settled", { settledOverride: "settled" })].map(isListedThread),
    ).toEqual([false, true]);
  });
});

describe("threadSubsessionState", () => {
  const parent = ThreadId.make("parent");
  const root = ThreadId.make("root");
  const fromTask = { type: "node" as const, threadId: parent, nodeId: NodeId.make("task") };
  const subagent = {
    parentThreadId: parent,
    relationshipToParent: "subagent" as const,
    rootThreadId: root,
  };

  it.each([
    [
      "a delegated child",
      { lineage: subagent, creationSource: "mcp", forkedFrom: fromTask },
      "attached",
    ],
    // Provider-native subagents run inside their parent's turn and cannot stand alone.
    [
      "a provider-native child",
      { lineage: subagent, creationSource: "provider", forkedFrom: fromTask },
      null,
    ],
    [
      "a subsession detached beside its parent",
      {
        lineage: {
          parentThreadId: null,
          relationshipToParent: null,
          rootThreadId: root,
          detachedFrom: { threadId: parent },
        },
        creationSource: "mcp",
        forkedFrom: fromTask,
      },
      "detached-grouped",
    ],
    [
      "a subsession detached on its own",
      {
        lineage: {
          parentThreadId: null,
          relationshipToParent: null,
          rootThreadId: root,
          detachedFrom: { threadId: parent },
          groupThreadId: ThreadId.make("child"),
        },
        creationSource: "mcp",
        forkedFrom: fromTask,
      },
      "detached-separate",
    ],
    [
      "a fork",
      {
        lineage: {
          parentThreadId: parent,
          relationshipToParent: "fork" as const,
          rootThreadId: root,
        },
        creationSource: "web",
        forkedFrom: null,
      },
      null,
    ],
  ] as const)("knows %s", (_name, thread, expected) => {
    expect(threadSubsessionState(thread)).toBe(expected);
  });
});
