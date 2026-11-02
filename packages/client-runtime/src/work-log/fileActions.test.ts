import { describe, expect, it } from "vite-plus/test";

import {
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2FileChangeDetail,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import {
  commandWorkAction,
  formatFileActionLabel,
  readTitleWithPath,
  settleFileActions,
  workItemFileActions,
} from "./fileActions.ts";

const RUN = RunId.make("run-1");

function baseItem(id: string) {
  return {
    id: TurnItemId.make(id),
    threadId: ThreadId.make("thread"),
    runId: RUN,
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
    updatedAt: DateTime.makeUnsafe("2026-11-02T00:00:00.000Z"),
  } as const;
}

function fileChange(
  id: string,
  fileName: string,
  fields: {
    readonly changes?: ReadonlyArray<OrchestrationV2FileChangeDetail>;
    readonly additions?: number;
    readonly deletions?: number;
    readonly status?: "failed" | "cancelled";
  } = {},
): OrchestrationV2TurnItem {
  return { ...baseItem(id), type: "file_change", fileName, ...fields };
}

function command(
  id: string,
  input: string,
  fields: { readonly status?: "running" | "completed"; readonly exitCode?: number } = {},
): Extract<OrchestrationV2TurnItem, { type: "command_execution" }> {
  return { ...baseItem(id), type: "command_execution", input, ...fields };
}

function checkpoint(
  files: ReadonlyArray<{ path: string; kind: string; additions: number; deletions: number }>,
  status: "ready" | "missing" = "ready",
) {
  return { runId: RUN, status, files };
}

describe("workItemFileActions", () => {
  it("gives each file of a patch its own row, keeping the first row's id as the patch grows", () => {
    const one = fileChange("patch", "/repo/a.ts", {
      changes: [{ operation: "add", path: "/repo/a.ts" }],
    });
    const many = fileChange("patch", "/repo/a.ts", {
      changes: [
        { operation: "add", path: "/repo/a.ts" },
        { operation: "delete", path: "/repo/b.ts" },
        { operation: "update", path: "/repo/d.ts", oldPath: "/repo/c.ts" },
        { operation: "update", path: "/repo/e.ts" },
      ],
    });
    expect(workItemFileActions(one)).toEqual([
      { id: "patch", action: { kind: "create", path: "/repo/a.ts", exact: true } },
    ]);
    expect(workItemFileActions(many)).toEqual([
      { id: "patch", action: { kind: "create", path: "/repo/a.ts", exact: true } },
      { id: "patch:1", action: { kind: "delete", path: "/repo/b.ts", exact: true } },
      {
        id: "patch:2",
        action: { kind: "move", path: "/repo/d.ts", fromPath: "/repo/c.ts", exact: true },
      },
      { id: "patch:3", action: { kind: "edit", path: "/repo/e.ts", exact: true } },
    ]);
  });

  it.each([
    ["created", { kind: "create", exact: true }],
    ["removed", { kind: "delete", exact: true }],
    ["rename", { kind: "move", exact: true }],
    ["modified", { kind: "edit", exact: true }],
    ["patch", { kind: "edit", exact: false }],
  ] as const)("reads the provider's %s operation", (operation, expected) => {
    expect(
      workItemFileActions(fileChange("x", "a.ts", { changes: [{ operation, path: "a.ts" }] })),
    ).toEqual([{ id: "x", action: { path: "a.ts", ...expected } }]);
  });

  it.each(["failed", "cancelled"] as const)("names no action for a %s change", (status) => {
    expect(
      workItemFileActions(
        fileChange("x", "a.ts", { status, changes: [{ operation: "add", path: "a.ts" }] }),
      ),
    ).toEqual([]);
  });

  it("calls a change with no operation an edit the checkpoint may correct, with its own counts", () => {
    expect(workItemFileActions(fileChange("w", "/repo/a.ts"))).toEqual([
      { id: "w", action: { kind: "edit", path: "/repo/a.ts", exact: false } },
    ]);
    expect(
      workItemFileActions(fileChange("c", "/repo/a.ts", { additions: 3, deletions: 1 })),
    ).toEqual([
      {
        id: "c",
        action: { kind: "edit", path: "/repo/a.ts", exact: false, additions: 3, deletions: 1 },
      },
    ]);
  });
});

describe("commandWorkAction", () => {
  it.each([
    ["touch notes.md", { kind: "create", path: "notes.md", exact: true }],
    ["rm -f old.md", { kind: "delete", path: "old.md", exact: true }],
    ["mv a.ts b.ts", { kind: "move", path: "b.ts", fromPath: "a.ts", exact: true }],
    ["printf 'x\\n' > notes.md", { kind: "write", path: "notes.md", exact: false }],
    [
      "sed -n '1,120p' src/app.ts",
      { kind: "read", paths: ["src/app.ts"], lines: { start: 1, end: 120 } },
    ],
    ["cat a.ts b.ts", { kind: "read", paths: ["a.ts", "b.ts"] }],
    ["rg -n useEffect apps/web", { kind: "search", query: "useEffect", path: "apps/web" }],
  ] as const)("names what a finished command did: %s", (input, action) => {
    expect(commandWorkAction(command("c", input))).toEqual(action);
  });

  it.each([
    ["touch a.md", { status: "running" }],
    ["rm a.md", { exitCode: 1 }],
    ["rm a.md && touch b.md", {}],
    ["git add . && git commit -m wip", {}],
    ["vp test run", {}],
  ] as const)(
    "keeps the command for running, failed, chained and other commands: %s",
    (input, fields) => {
      expect(commandWorkAction(command("c", input, fields))).toBeNull();
    },
  );
});

describe("formatFileActionLabel", () => {
  it.each([
    [{ kind: "create", path: "src/a.ts", exact: true }, "Created src/a.ts"],
    [{ kind: "edit", path: "src/a.ts", exact: false }, "Edited src/a.ts"],
    [{ kind: "delete", path: "src/a.ts", exact: true }, "Deleted src/a.ts"],
    [
      { kind: "move", path: "src/b.ts", fromPath: "src/a.ts", exact: true },
      "Moved src/a.ts → src/b.ts",
    ],
    [{ kind: "write", path: "src/a.ts", exact: false }, "Wrote src/a.ts"],
  ] as const)("%j", (action, label) => {
    expect(formatFileActionLabel(action)).toBe(label);
  });
});

describe("readTitleWithPath", () => {
  it.each([
    ["Read /repo/game.js lines 3-6", "game/game.js", "Read game/game.js lines 3-6"],
    ["Read /repo/game.js", "game/game.js", "Read game/game.js"],
    ["Read game.js lines 3-6", "game/game.js", null],
    [null, "game/game.js", null],
  ] as const)("keeps the provider's line range on %s", (title, displayPath, label) => {
    expect(readTitleWithPath(title, "/repo/game.js", displayPath)).toBe(label);
  });
});

describe("settleFileActions", () => {
  it("leaves live rows alone until their run has a ready checkpoint", () => {
    const items = [command("w", "printf x > notes.md"), fileChange("e", "/repo/a.ts")];
    expect(settleFileActions(items, []).size).toBe(0);
    expect(
      settleFileActions(items, [
        checkpoint([{ path: "notes.md", kind: "added", additions: 1, deletions: 0 }], "missing"),
      ]).size,
    ).toBe(0);
  });

  it("says Created for a redirect that made a new file, with the file's counts", () => {
    const settled = settleFileActions(
      [command("w", "printf 'a\\nb\\n' > notes.md")],
      [checkpoint([{ path: "notes.md", kind: "added", additions: 2, deletions: 0 }])],
    );
    expect(settled.get("w")).toEqual({
      kind: "create",
      path: "notes.md",
      exact: false,
      additions: 2,
      deletions: 0,
    });
  });

  it("calls only the first row on a new file Created, and gives no counts when rows share a file", () => {
    const settled = settleFileActions(
      [fileChange("write", "/repo/a.ts"), fileChange("edit", "/repo/a.ts")],
      [checkpoint([{ path: "a.ts", kind: "added", additions: 9, deletions: 0 }])],
    );
    expect(settled.get("write")).toEqual({ kind: "create", path: "/repo/a.ts", exact: false });
    expect(settled.get("edit")).toBeUndefined();
  });

  it("calls the last row on a removed file Deleted", () => {
    const settled = settleFileActions(
      [fileChange("edit", "/repo/a.ts"), fileChange("delete", "/repo/a.ts")],
      [checkpoint([{ path: "a.ts", kind: "deleted", additions: 0, deletions: 4 }])],
    );
    expect(settled.get("edit")).toBeUndefined();
    expect(settled.get("delete")).toEqual({ kind: "delete", path: "/repo/a.ts", exact: false });
  });

  it("keeps a kind the provider named and adds the counts when one row owns the file", () => {
    const settled = settleFileActions(
      [
        fileChange("patch", "/repo/a.ts", {
          changes: [
            { operation: "update", path: "/repo/a.ts" },
            { operation: "add", path: "/repo/b.ts" },
          ],
        }),
      ],
      [
        checkpoint([
          { path: "a.ts", kind: "added", additions: 5, deletions: 0 },
          { path: "b.ts", kind: "added", additions: 3, deletions: 0 },
        ]),
      ],
    );
    expect(settled.get("patch")).toEqual({
      kind: "edit",
      path: "/repo/a.ts",
      exact: true,
      additions: 5,
      deletions: 0,
    });
    expect(settled.get("patch:1")).toEqual({
      kind: "create",
      path: "/repo/b.ts",
      exact: true,
      additions: 3,
      deletions: 0,
    });
  });

  it("matches an absolute row path to the longest repository path the checkpoint lists", () => {
    const settled = settleFileActions(
      [fileChange("w", "/home/me/repo/vendor/src/a.ts")],
      [
        checkpoint([
          { path: "src/a.ts", kind: "modified", additions: 1, deletions: 1 },
          { path: "vendor/src/a.ts", kind: "added", additions: 7, deletions: 0 },
        ]),
      ],
    );
    expect(settled.get("w")).toMatchObject({ kind: "create", additions: 7, deletions: 0 });
  });

  it("keeps the live kind when the checkpoint does not list the file", () => {
    const settled = settleFileActions(
      [command("w", "printf x > notes.md")],
      [checkpoint([{ path: "other.md", kind: "added", additions: 1, deletions: 0 }])],
    );
    expect(settled.size).toBe(0);
  });
});
