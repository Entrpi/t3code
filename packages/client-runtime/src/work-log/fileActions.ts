import type { OrchestrationV2TurnItem, RunId } from "@t3tools/contracts";
import {
  formatReadToolLabel,
  formatSearchToolLabel,
  type ReadLineRange,
} from "@t3tools/shared/toolActivity";

import {
  classifyShellCommand,
  MAX_CLASSIFIED_LENGTH,
  type ShellCommandAction,
  type ShellCommandClassification,
} from "./shellCommandActions.ts";

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
  | { readonly kind: "search"; readonly query?: string; readonly path?: string }
  | { readonly kind: "list"; readonly path?: string };

/** A command that does more than one read, search or file action. */
export interface WorkEntryCommandEffects {
  /** In command order. */
  readonly files: ReadonlyArray<WorkEntryFileAction>;
  readonly commits: number;
  /** More than one command, joined by `&&`, `;` or a pipe. */
  readonly chained: boolean;
}

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

const EFFECT_ORDER: ReadonlyArray<FileActionKind> = ["edit", "write", "create", "move", "delete"];
const EFFECT_NOUNS: Record<FileActionKind, readonly [string, string]> = {
  edit: ["file edit", "file edits"],
  write: ["file written", "files written"],
  create: ["file created", "files created"],
  move: ["file moved", "files moved"],
  delete: ["file deleted", "files deleted"],
};

const classificationCache = new WeakMap<CommandItem, ShellCommandClassification | null>();
const commandActionCache = new WeakMap<
  CommandItem,
  WorkEntryCommandAction | WorkEntryFileAction | null
>();
const commandEffectsCache = new WeakMap<CommandItem, WorkEntryCommandEffects | null>();
const fileActionsCache = new WeakMap<
  OrchestrationV2TurnItem,
  ReadonlyArray<{ readonly id: string; readonly action: WorkEntryFileAction }>
>();

function isFileAction(
  action: WorkEntryCommandAction | WorkEntryFileAction,
): action is WorkEntryFileAction {
  return action.kind !== "read" && action.kind !== "search" && action.kind !== "list";
}

/**
 * What a finished, successful command did when that is one read, search or listing, or
 * one file action among reads, searches and listings. Anything else keeps showing the command.
 */
export function commandWorkAction(
  item: CommandItem,
): WorkEntryCommandAction | WorkEntryFileAction | null {
  const cached = commandActionCache.get(item);
  if (cached !== undefined) return cached;
  const classification = settledClassification(item);
  const action = classification === null ? null : commandActionFromClassification(classification);
  commandActionCache.set(item, action);
  return action;
}

/**
 * The file actions and commits of a finished, successful command that
 * `commandWorkAction` cannot name as one action. Exit 0 is the only proof a
 * commit landed; a chain that ignores a failed commit still counts it.
 */
export function commandWorkEffects(item: CommandItem): WorkEntryCommandEffects | null {
  const cached = commandEffectsCache.get(item);
  if (cached !== undefined) return cached;
  const classification = settledClassification(item);
  let effects: WorkEntryCommandEffects | null = null;
  if (classification !== null && commandWorkAction(item) === null) {
    const files = classification.actions.flatMap((action) => {
      const file = shellFileAction(action);
      return file === null ? [] : [file];
    });
    const commits = classification.actions.filter((action) => action.kind === "commit").length;
    if (files.length > 0 || commits > 0) {
      effects = { files, commits, chained: classification.segments > 1 };
    }
  }
  commandEffectsCache.set(item, effects);
  return effects;
}

function settledClassification(item: CommandItem): ShellCommandClassification | null {
  if (item.status !== "completed" || (item.exitCode ?? 0) !== 0) return null;
  const cached = classificationCache.get(item);
  if (cached !== undefined) return cached;
  const classification = classifyShellCommand(item.input);
  classificationCache.set(item, classification);
  return classification;
}

function shellFileAction(action: ShellCommandAction): WorkEntryFileAction | null {
  switch (action.kind) {
    case "create":
    case "delete":
      return { kind: action.kind, path: action.path, exact: true };
    case "edit":
      return { kind: "write", path: action.path, exact: false };
    case "move":
      return { kind: "move", path: action.toPath, fromPath: action.path, exact: true };
    default:
      return null;
  }
}

function commandActionFromClassification({
  actions,
  other,
}: ShellCommandClassification): WorkEntryCommandAction | WorkEntryFileAction | null {
  const [first] = actions;
  if (other || first === undefined) return null;
  const reads = actions.filter((action) => action.kind === "read");
  if (reads.length === actions.length) {
    const paths = reads.map((read) => read.path);
    const lines = reads.length === 1 ? reads[0]!.lines : undefined;
    return lines === undefined ? { kind: "read", paths } : { kind: "read", paths, lines };
  }
  if (actions.length !== 1) {
    const files = actions.flatMap((action) => {
      const file = shellFileAction(action);
      return file === null ? [] : [file];
    });
    const commits = actions.some((action) => action.kind === "commit");
    return files.length === 1 && !commits ? files[0]! : null;
  }
  if (first.kind === "list") return first;
  if (first.kind !== "search") return shellFileAction(first);
  const { kind: _kind, ...search } = first;
  return formatSearchToolLabel({ input: search }) === undefined
    ? null
    : { kind: "search", ...search };
}

/**
 * "Chained command with 1 file edit, 2 files deleted and 1 commit"; one command
 * naming several files of one kind reads "Deleted 2 files". Null keeps the command.
 */
export function formatCommandEffectsLabel(effects: WorkEntryCommandEffects): string | null {
  if (effects.files.length === 0) return null;
  const counts = EFFECT_ORDER.flatMap((kind) => {
    const count = new Set(
      effects.files.filter((file) => file.kind === kind).map((file) => file.path),
    ).size;
    return count === 0 ? [] : [{ kind, count }];
  });
  if (!effects.chained && counts.length === 1 && effects.commits === 0) {
    const { kind, count } = counts[0]!;
    return `${VERBS[kind]} ${count} ${count === 1 ? "file" : "files"}`;
  }
  const files = counts
    .map(({ kind, count }) => `${count} ${EFFECT_NOUNS[kind][count === 1 ? 0 : 1]}`)
    .join(", ");
  const commits =
    effects.commits === 0
      ? ""
      : ` and ${effects.commits} ${effects.commits === 1 ? "commit" : "commits"}`;
  return `${effects.chained ? "Chained command" : "Command"} with ${files}${commits}`;
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

/** A chained command stays one row; each of its files settles under its own id. */
function commandFileActions(item: CommandItem) {
  const action = commandWorkAction(item);
  if (action !== null) return isFileAction(action) ? [{ id: item.id, action }] : [];
  return (commandWorkEffects(item)?.files ?? []).map((file, index) => ({
    id: commandEffectFileId(item.id, index),
    action: file,
  }));
}

function commandEffectFileId(itemId: string, index: number): string {
  return `${itemId}:${index}`;
}

/** The effects with each file's settled kind and counts. */
function settleCommandEffects(
  itemId: string,
  effects: WorkEntryCommandEffects,
  settled: ReadonlyMap<string, WorkEntryFileAction | null>,
): WorkEntryCommandEffects {
  if (settled.size === 0) return effects;
  let changed = false;
  const files = effects.files.flatMap((file, index) => {
    const next = settled.get(commandEffectFileId(itemId, index));
    if (next === undefined) return [file];
    changed = true;
    return next === null ? [] : [next];
  });
  return changed ? { ...effects, files } : effects;
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
  if (action.kind === "list") {
    return action.path === undefined ? "Listed files" : `Listed ${formatPath(action.path)}`;
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
 * A run's settled file rows, by row id; null drops a row's action. Empty until the run has a
 * ready checkpoint.
 */
export type FileActionSettlement = (
  runId: RunId | null,
) => ReadonlyMap<string, WorkEntryFileAction | null>;

/**
 * Settles each run's file rows the first time one of its rows is shown. An inexact kind takes
 * the checkpoint's: a new file is Created by its first row, a removed one Deleted by its last.
 * Counts are the checkpoint's only when no other row in the run touches the file.
 */
export function settleFileActions(
  items: () => Iterable<OrchestrationV2TurnItem>,
  checkpoints: ReadonlyArray<SettleCheckpoint>,
): FileActionSettlement {
  const ready = readyCheckpoints(checkpoints);
  if (ready.size === 0) return () => NO_SETTLED_ACTIONS;
  let itemsByRun: Map<RunId, OrchestrationV2TurnItem[]> | undefined;
  const settledByRun = new Map<RunId, ReadonlyMap<string, WorkEntryFileAction | null>>();
  return (runId) => {
    const checkpoint = runId === null ? undefined : ready.get(runId);
    if (runId === null || checkpoint === undefined) return NO_SETTLED_ACTIONS;
    let settled = settledByRun.get(runId);
    if (settled === undefined) {
      itemsByRun ??= groupItemsByRun(items(), ready);
      settled = settleRun(itemsByRun.get(runId) ?? [], checkpoint.files);
      settledByRun.set(runId, settled);
    }
    return settled;
  };
}

const NO_SETTLED_ACTIONS: ReadonlyMap<string, WorkEntryFileAction | null> = new Map();

const readyCheckpointsCache = new WeakMap<
  ReadonlyArray<SettleCheckpoint>,
  ReadonlyMap<RunId, SettleCheckpoint>
>();

function readyCheckpoints(checkpoints: ReadonlyArray<SettleCheckpoint>) {
  const cached = readyCheckpointsCache.get(checkpoints);
  if (cached !== undefined) return cached;
  const ready = new Map<RunId, SettleCheckpoint>();
  for (const checkpoint of checkpoints) {
    if (checkpoint.status === "ready" && checkpoint.files.length > 0) {
      ready.set(checkpoint.runId, checkpoint);
    }
  }
  readyCheckpointsCache.set(checkpoints, ready);
  return ready;
}

function groupItemsByRun(
  items: Iterable<OrchestrationV2TurnItem>,
  ready: ReadonlyMap<RunId, SettleCheckpoint>,
) {
  const itemsByRun = new Map<RunId, OrchestrationV2TurnItem[]>();
  for (const item of items) {
    if (item.runId === null || !ready.has(item.runId)) continue;
    const runItems = itemsByRun.get(item.runId);
    if (runItems === undefined) itemsByRun.set(item.runId, [item]);
    else runItems.push(item);
  }
  return itemsByRun;
}

// Settled runs keep their items and checkpoint, so every feed update after the first reuses this.
const settledRunCache = new WeakMap<
  SettleCheckpoint["files"],
  {
    readonly items: ReadonlyArray<OrchestrationV2TurnItem>;
    readonly settled: ReadonlyMap<string, WorkEntryFileAction | null>;
  }
>();

function settleRun(
  items: ReadonlyArray<OrchestrationV2TurnItem>,
  checkpointFiles: SettleCheckpoint["files"],
): ReadonlyMap<string, WorkEntryFileAction | null> {
  const cached = settledRunCache.get(checkpointFiles);
  if (
    cached !== undefined &&
    cached.items.length === items.length &&
    cached.items.every((item, index) => item === items[index])
  ) {
    return cached.settled;
  }
  const rows = items.flatMap((item) =>
    workItemFileActions(item).map((row) => ({ ...row, shell: item.type === "command_execution" })),
  );
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
  const settled = new Map<string, WorkEntryFileAction | null>();
  rows.forEach(({ id, action, shell }, index) => {
    const key = keys[index]!;
    const file = files.get(key);
    if (file === undefined) return;
    // The file outlived the command, as under an `rm -i` alias that exits 0.
    if (shell && action.kind === "delete" && last.get(key) === index && file.kind !== "deleted") {
      settled.set(id, null);
      return;
    }
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
    settled.set(id, { ...action, kind, ...counts });
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

interface PresentableWorkEntry {
  readonly id: string;
  readonly label: string;
  readonly changedFiles?: ReadonlyArray<string>;
  readonly structuredPayload?: OrchestrationV2TurnItem;
  readonly fileAction?: WorkEntryFileAction | undefined;
  readonly commandAction?: WorkEntryCommandAction | undefined;
  readonly commandEffects?: WorkEntryCommandEffects | undefined;
}

// Rows keep their identity while an entry and its run's settled rows are unchanged.
const presentedRowsCache = new WeakMap<
  PresentableWorkEntry,
  {
    readonly settled: ReadonlyMap<string, WorkEntryFileAction | null>;
    readonly rows: ReadonlyArray<PresentableWorkEntry>;
  }
>();

/**
 * The rows a shown work entry gives: a command names its read, search or file action, or its
 * effects, and a patch gives one row per file. Classifying is the costly part, so callers present only the
 * entries they show.
 */
export function presentWorkEntry<E extends PresentableWorkEntry>(
  entry: E,
  settle: FileActionSettlement,
): ReadonlyArray<E> {
  const item = entry.structuredPayload;
  if (item?.type !== "command_execution" && item?.type !== "file_change") return [entry];
  const settled = settle(item.runId);
  const cached = presentedRowsCache.get(entry);
  if (cached?.settled === settled) return cached.rows as ReadonlyArray<E>;
  const fileRows = workItemFileActions(item);
  const actions = fileRows.map(({ id, action }) => settled.get(id) ?? action);
  let rows: ReadonlyArray<E>;
  if (item.type === "command_execution") {
    const action = commandWorkAction(item);
    const effects = action === null ? commandWorkEffects(item) : null;
    const overruled = action !== null && isFileAction(action) && settled.get(item.id) === null;
    rows =
      (action === null && effects === null) || overruled
        ? [entry]
        : [
            {
              ...entry,
              fileAction: action !== null && isFileAction(action) ? actions[0] : undefined,
              commandAction: action !== null && !isFileAction(action) ? action : undefined,
              commandEffects:
                effects === null ? undefined : settleCommandEffects(item.id, effects, settled),
            },
          ];
  } else {
    rows =
      fileRows.length === 0
        ? [entry]
        : fileRows.map(({ id }, index) => ({
            ...entry,
            id,
            label: formatFileActionLabel(actions[index]!),
            changedFiles: [actions[index]!.path],
            fileAction: actions[index],
          }));
  }
  presentedRowsCache.set(entry, { settled, rows });
  return rows;
}

const commitCountCache = new WeakMap<CommandItem, number>();

/** `presentWorkEntry` over a list, giving back the list itself when no entry changes. */
export function presentWorkEntries<E extends PresentableWorkEntry>(
  entries: E[],
  settle: FileActionSettlement,
): E[] {
  let presented: E[] | undefined;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    const type = entry.structuredPayload?.type;
    const rows =
      type === "command_execution" || type === "file_change"
        ? presentWorkEntry(entry, settle)
        : undefined;
    if (rows === undefined || (rows.length === 1 && rows[0] === entry)) {
      presented?.push(entry);
      continue;
    }
    presented ??= entries.slice(0, index);
    presented.push(...rows);
  }
  return presented ?? entries;
}

/** Commits a finished command made. Only commands that name `commit` are classified. */
export function workItemCommitCount(item: OrchestrationV2TurnItem | undefined): number {
  if (item?.type !== "command_execution") return 0;
  const cached = commitCountCache.get(item);
  if (cached !== undefined) return cached;
  // The classifier reads no further than this into a long command.
  const text = item.input.slice(0, MAX_CLASSIFIED_LENGTH);
  const commits = text.includes("commit") ? (commandWorkEffects(item)?.commits ?? 0) : 0;
  commitCountCache.set(item, commits);
  return commits;
}
