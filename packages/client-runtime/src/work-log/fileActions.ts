import type { OrchestrationV2TurnItem, RunId } from "@t3tools/contracts";
import {
  formatReadToolLabel,
  formatSearchToolLabel,
  type ReadLineRange,
} from "@t3tools/shared/toolActivity";

import { classifyShellCommand } from "./shellCommandActions.ts";

/** `write` is a shell redirect, which cannot tell a new file from an edited one. */
export type FileActionKind = "create" | "edit" | "delete" | "move" | "write";

export interface WorkEntryFileAction {
  readonly kind: FileActionKind;
  readonly path: string;
  readonly fromPath?: string;
  /** The provider or the command named the kind, so a checkpoint does not overrule it. */
  readonly exact: boolean;
  /** Line counts for this row alone; absent when unknown. */
  readonly additions?: number;
  readonly deletions?: number;
}

export type WorkEntryCommandAction =
  | {
      readonly kind: "read";
      readonly paths: ReadonlyArray<string>;
      readonly lines?: ReadLineRange;
    }
  | { readonly kind: "search"; readonly query?: string; readonly path?: string };

type FileChangeItem = Extract<OrchestrationV2TurnItem, { readonly type: "file_change" }>;
type CommandItem = Extract<OrchestrationV2TurnItem, { readonly type: "command_execution" }>;

const OPERATION_KINDS: Record<string, "create" | "edit" | "delete" | "move"> = {
  add: "create",
  added: "create",
  create: "create",
  created: "create",
  delete: "delete",
  deleted: "delete",
  remove: "delete",
  removed: "delete",
  move: "move",
  moved: "move",
  rename: "move",
  renamed: "move",
  update: "edit",
  updated: "edit",
  edit: "edit",
  edited: "edit",
  modify: "edit",
  modified: "edit",
};

const VERBS: Record<FileActionKind, string> = {
  create: "Created",
  edit: "Edited",
  delete: "Deleted",
  move: "Moved",
  write: "Wrote",
};

const commandActionCache = new WeakMap<
  CommandItem,
  WorkEntryCommandAction | WorkEntryFileAction | null
>();
const fileActionsCache = new WeakMap<
  OrchestrationV2TurnItem,
  ReadonlyArray<{ readonly id: string; readonly action: WorkEntryFileAction }>
>();

export function isFileAction(
  action: WorkEntryCommandAction | WorkEntryFileAction,
): action is WorkEntryFileAction {
  return action.kind !== "read" && action.kind !== "search";
}

/**
 * What a finished, successful command did when that is one read, one search or
 * one file action. Anything else keeps showing the command.
 */
export function commandWorkAction(
  item: CommandItem,
): WorkEntryCommandAction | WorkEntryFileAction | null {
  const cached = commandActionCache.get(item);
  if (cached !== undefined) return cached;
  const action =
    item.status === "completed" && (item.exitCode ?? 0) === 0
      ? commandActionFromText(item.input)
      : null;
  commandActionCache.set(item, action);
  return action;
}

function commandActionFromText(
  command: string,
): WorkEntryCommandAction | WorkEntryFileAction | null {
  const { actions, other } = classifyShellCommand(command);
  const [first] = actions;
  if (other || first === undefined) return null;
  const reads = actions.filter((action) => action.kind === "read");
  if (reads.length === actions.length) {
    const paths = reads.map((read) => read.path);
    const lines = reads.length === 1 ? reads[0]!.lines : undefined;
    return lines === undefined ? { kind: "read", paths } : { kind: "read", paths, lines };
  }
  if (actions.length !== 1) return null;
  switch (first.kind) {
    case "search": {
      const { kind: _kind, ...search } = first;
      return formatSearchToolLabel({ input: search }) === undefined
        ? null
        : { kind: "search", ...search };
    }
    case "create":
    case "delete":
      return { kind: first.kind, path: first.path, exact: true };
    case "edit":
      return { kind: "write", path: first.path, exact: false };
    case "move":
      return { kind: "move", path: first.toPath, fromPath: first.path, exact: true };
    default:
      return null;
  }
}

/**
 * The file rows an item shows: one per changed file, ids stable as a patch
 * grows. A failed or stopped change names no action.
 */
export function workItemFileActions(
  item: OrchestrationV2TurnItem,
): ReadonlyArray<{ readonly id: string; readonly action: WorkEntryFileAction }> {
  if (item.type !== "file_change" && item.type !== "command_execution") return [];
  const cached = fileActionsCache.get(item);
  if (cached !== undefined) return cached;
  const actions = item.type === "file_change" ? fileChangeActions(item) : commandFileActions(item);
  fileActionsCache.set(item, actions);
  return actions;
}

function commandFileActions(item: CommandItem) {
  const action = commandWorkAction(item);
  return action !== null && isFileAction(action) ? [{ id: item.id, action }] : [];
}

function fileChangeActions(item: FileChangeItem) {
  if (item.status === "failed" || item.status === "cancelled" || item.status === "interrupted") {
    return [];
  }
  if (item.changes === undefined || item.changes.length === 0) {
    const counts =
      item.additions !== undefined && item.deletions !== undefined
        ? { additions: item.additions, deletions: item.deletions }
        : {};
    return [
      {
        id: item.id,
        action: { kind: "edit", path: item.fileName, exact: false, ...counts } as const,
      },
    ];
  }
  return item.changes.map((change, index) => {
    const named = OPERATION_KINDS[change.operation.toLowerCase()];
    const kind = change.oldPath !== undefined ? "move" : (named ?? "edit");
    return {
      // The first row keeps the item's id, so its state survives a patch that grows.
      id: index === 0 ? item.id : `${item.id}:${index}`,
      action: {
        kind,
        path: change.path,
        ...(kind === "move" && change.oldPath !== undefined ? { fromPath: change.oldPath } : {}),
        exact: named !== undefined || kind === "move",
      } satisfies WorkEntryFileAction,
    };
  });
}

export function formatFileActionLabel(
  action: WorkEntryFileAction,
  formatPath: (path: string) => string = (path) => path,
): string {
  const verb = VERBS[action.kind];
  return action.fromPath === undefined
    ? `${verb} ${formatPath(action.path)}`
    : `${verb} ${formatPath(action.fromPath)} → ${formatPath(action.path)}`;
}

export function fileActionVerb(kind: FileActionKind): string {
  return VERBS[kind];
}

export function formatCommandActionLabel(
  action: WorkEntryCommandAction,
  formatPath: (path: string) => string = (path) => path,
): string {
  if (action.kind === "read") {
    return formatReadToolLabel(formatPath(action.paths[0]!), action.paths.length - 1, action.lines);
  }
  const { kind: _kind, ...search } = action;
  return formatSearchToolLabel({ input: search }) ?? "Searched code";
}

/**
 * A read title the server built with `formatReadToolLabel`, shown with `displayPath`.
 * Only the server knows each provider's line numbering, so its range is kept.
 */
export function readTitleWithPath(
  title: string | null | undefined,
  rawPath: string,
  displayPath: string,
): string | null {
  const prefix = `Read ${rawPath}`;
  return title?.startsWith(prefix) ? `Read ${displayPath}${title.slice(prefix.length)}` : null;
}

interface SettleCheckpoint {
  readonly runId: RunId;
  readonly status: string;
  readonly files: ReadonlyArray<{
    readonly path: string;
    readonly kind: string;
    readonly additions: number;
    readonly deletions: number;
    readonly binary?: true | undefined;
  }>;
}

/**
 * Changed file rows of runs with a ready checkpoint, by row id. An inexact kind takes the
 * checkpoint's: a new file is Created by its first row, a removed one Deleted by its last.
 * Counts are the checkpoint's only when no other row in the run touches the file.
 */
export function settleFileActions(
  items: Iterable<OrchestrationV2TurnItem>,
  checkpoints: ReadonlyArray<SettleCheckpoint>,
): ReadonlyMap<string, WorkEntryFileAction> {
  const settled = new Map<string, WorkEntryFileAction>();
  const readyRunIds = new Set(
    checkpoints.flatMap((checkpoint) =>
      checkpoint.status === "ready" && checkpoint.files.length > 0 ? [checkpoint.runId] : [],
    ),
  );
  if (readyRunIds.size === 0) return settled;
  const itemsByRun = new Map<RunId, OrchestrationV2TurnItem[]>();
  const seenItemIds = new Set<string>();
  for (const item of items) {
    if (item.runId === null || !readyRunIds.has(item.runId) || seenItemIds.has(item.id)) continue;
    seenItemIds.add(item.id);
    if (workItemFileActions(item).length === 0) continue;
    const runItems = itemsByRun.get(item.runId);
    if (runItems === undefined) itemsByRun.set(item.runId, [item]);
    else runItems.push(item);
  }
  for (const checkpoint of checkpoints) {
    const runItems = checkpoint.status === "ready" ? itemsByRun.get(checkpoint.runId) : undefined;
    if (runItems === undefined) continue;
    for (const [id, action] of settleRun(runItems, checkpoint.files)) settled.set(id, action);
  }
  return settled;
}

// Settled runs keep their items and checkpoint, so every feed update after the first reuses this.
const settledRunCache = new WeakMap<
  SettleCheckpoint["files"],
  {
    readonly items: ReadonlyArray<OrchestrationV2TurnItem>;
    readonly settled: ReadonlyArray<readonly [string, WorkEntryFileAction]>;
  }
>();

function settleRun(
  items: ReadonlyArray<OrchestrationV2TurnItem>,
  checkpointFiles: SettleCheckpoint["files"],
): ReadonlyArray<readonly [string, WorkEntryFileAction]> {
  const cached = settledRunCache.get(checkpointFiles);
  if (
    cached !== undefined &&
    cached.items.length === items.length &&
    cached.items.every((item, index) => item === items[index])
  ) {
    return cached.settled;
  }
  const rows = items.flatMap((item) => workItemFileActions(item));
  const files = checkpointFilesByPath(checkpointFiles);
  const keys = rows.map((row) => checkpointPath(row.action.path, files));
  const first = new Map<string, number>();
  const last = new Map<string, number>();
  const touches = new Map<string, number>();
  keys.forEach((key, index) => {
    if (!first.has(key)) first.set(key, index);
    last.set(key, index);
    touches.set(key, (touches.get(key) ?? 0) + 1);
  });
  const settled: Array<readonly [string, WorkEntryFileAction]> = [];
  rows.forEach(({ id, action }, index) => {
    const key = keys[index]!;
    const file = files.get(key);
    if (file === undefined) return;
    const kind = action.exact
      ? action.kind
      : file.kind === "added" || file.kind === "renamed"
        ? first.get(key) === index
          ? "create"
          : "edit"
        : file.kind === "deleted" && last.get(key) === index
          ? "delete"
          : "edit";
    const counts =
      action.additions === undefined && touches.get(key) === 1 && file.binary !== true
        ? { additions: file.additions, deletions: file.deletions }
        : {};
    if (kind === action.kind && !("additions" in counts)) return;
    settled.push([id, { ...action, kind, ...counts }]);
  });
  settledRunCache.set(checkpointFiles, { items, settled });
  return settled;
}

const filesByPathCache = new WeakMap<
  SettleCheckpoint["files"],
  ReadonlyMap<string, SettleCheckpoint["files"][number]>
>();

function checkpointFilesByPath(files: SettleCheckpoint["files"]) {
  const cached = filesByPathCache.get(files);
  if (cached !== undefined) return cached;
  const byPath = new Map(files.map((file) => [file.path, file]));
  filesByPathCache.set(files, byPath);
  return byPath;
}

/**
 * Checkpoint paths are repository-relative; rows carry absolute or
 * workspace-relative paths. The longest trailing part the checkpoint lists wins.
 */
function checkpointPath(path: string, files: ReadonlyMap<string, unknown>): string {
  const parts = path.replaceAll("\\", "/").split("/");
  for (let index = 0; index < parts.length; index += 1) {
    const candidate = parts.slice(index).join("/");
    if (files.has(candidate)) return candidate;
  }
  return path;
}
