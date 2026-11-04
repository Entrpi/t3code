import { describe, expect, it } from "vite-plus/test";

import { NodeId, ThreadId } from "@t3tools/contracts";

import {
  buildThreadActionMenuItems,
  threadSubsessionState,
  type ThreadActionMenuState,
} from "./threadActionMenu.logic";

const baseState: ThreadActionMenuState = {
  canOperate: true,
  branch: null,
  projectFilter: null,
  isPinned: false,
  isSettled: false,
  autoSettleEnabled: true,
  isSnoozed: false,
  canSnoozeNow: true,
  isRegeneratingTitle: false,
  isRunning: false,
  supports: {
    settlement: true,
    autoSettleOptOut: true,
    snooze: true,
    pinning: true,
    titleRegeneration: true,
  },
  snoozePresets: [
    { id: "hour", label: "In 1 hour", whenLabel: "3:00 PM", snoozedUntil: "2026-08-07T15:00:00Z" },
  ],
};

describe("buildThreadActionMenuItems", () => {
  it.each([false, true])(
    "disables both lifecycle directions without permission (reversed: %s)",
    (reversed) => {
      const items = buildThreadActionMenuItems({
        ...baseState,
        canOperate: false,
        isPinned: reversed,
        isSettled: reversed,
        isSnoozed: reversed,
      });
      const expected = reversed
        ? [
            "unpin",
            "unsettle",
            "unsnooze",
            "rename",
            "regenerate-title",
            "auto-settle",
            "archive",
            "delete",
          ]
        : [
            "pin",
            "settle",
            "snooze",
            "rename",
            "regenerate-title",
            "auto-settle",
            "archive",
            "delete",
          ];
      expect(items.filter((item) => item.disabled).map((item) => item.id)).toEqual(expected);
      expect(
        items.find((item) => item.id === "snooze")?.children?.every((child) => child.disabled) ??
          true,
      ).toBe(true);
    },
  );

  it("disables archive and turning into a project while the thread is running", () => {
    const items = buildThreadActionMenuItems({
      ...baseState,
      isRunning: true,
      canTurnIntoProject: true,
    });
    expect(items.find((item) => item.id === "archive")?.disabled).toBe(true);
    expect(items.find((item) => item.id === "turn-into-project")?.disabled).toBe(true);
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
