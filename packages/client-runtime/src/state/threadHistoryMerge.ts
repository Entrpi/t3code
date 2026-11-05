import type {
  MessageId,
  OrchestrationV2ProjectedTurnItem,
  OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import {
  isOrchestrationV2TurnItemVisible,
  isOrchestrationV2UserTurnStart,
} from "@t3tools/shared/orchestrationV2Timeline";

import type { ThreadStructureTurnItem } from "./models.ts";

/** Wire rows and thread-structure rows both carry prompts unchanged. */
type TurnRow = { readonly item: ThreadStructureTurnItem };

export type ThreadHistoryMeta = {
  readonly historyCursor: string | null;
  readonly hasMoreHistory: boolean;
  readonly loading: boolean;
  readonly error: string | null;
  readonly expanded: boolean;
  readonly latestLocalTurnOrdinal: number | null;
  /** Prompts before the window's first prompt; null while unknown (an older server's partial window). */
  readonly userTurnsBeforeWindow: number | null;
};

export const EMPTY_THREAD_HISTORY_META: ThreadHistoryMeta = {
  historyCursor: null,
  hasMoreHistory: false,
  loading: false,
  error: null,
  expanded: false,
  latestLocalTurnOrdinal: null,
  userTurnsBeforeWindow: 0,
};

export function isActiveHistoryRequestCursor(
  requestCursor: string,
  history: { readonly historyCursor: string | null },
): boolean {
  return history.historyCursor === requestCursor;
}

export function clearActiveHistoryLoading(
  requestCursor: string,
  history: ThreadHistoryMeta,
): ThreadHistoryMeta {
  if (!isActiveHistoryRequestCursor(requestCursor, history) || !history.loading) {
    return history;
  }
  return { ...history, loading: false };
}

function projectedItemKey(row: OrchestrationV2ProjectedTurnItem): string {
  return `${row.sourceThreadId}:${row.sourceItemId}`;
}

function renumberVisible(
  rows: ReadonlyArray<OrchestrationV2ProjectedTurnItem>,
): OrchestrationV2ProjectedTurnItem[] {
  return rows.map((row, position) => (row.position === position ? row : { ...row, position }));
}

export function mergeOlderHistoryIntoProjection(
  projection: OrchestrationV2ThreadProjection,
  olderItems: ReadonlyArray<OrchestrationV2ProjectedTurnItem>,
  work?: { readonly anchorId: string; readonly nextCursor: string | null },
): OrchestrationV2ThreadProjection {
  if (olderItems.length === 0 && work === undefined) {
    return projection;
  }

  const start =
    work === undefined
      ? -1
      : projection.visibleTurnItems.findIndex((row) => row.sourceItemId === work.anchorId);
  const anchor = projection.visibleTurnItems[start];
  const deferred = anchor?.item.deferredWork;
  if (work !== undefined && deferred === undefined) return projection;
  const currentByKey = new Map(
    projection.visibleTurnItems.map((row) => [projectedItemKey(row), row]),
  );
  const turnItemById = new Map(projection.turnItems.map((item) => [String(item.id), item]));
  const pageKeys = new Set<string>();
  const page: OrchestrationV2ProjectedTurnItem[] = [];
  for (const pageRow of olderItems) {
    if (
      work &&
      anchor &&
      deferred &&
      (pageRow.sourceThreadId !== anchor.sourceThreadId ||
        pageRow.item.ordinal < anchor.item.ordinal ||
        pageRow.item.ordinal > deferred.lastOrdinal)
    )
      continue;
    const key = projectedItemKey(pageRow);
    if (pageKeys.has(key)) continue;
    let row = currentByKey.get(key) ?? pageRow;
    if (
      !currentByKey.has(key) &&
      (row.visibility === "local" || row.sourceThreadId === projection.thread.id)
    ) {
      const currentItem = turnItemById.get(String(row.sourceItemId));
      // Hidden live items stay hidden. Snapshots also retain interrupt requests and
      // pending request cards outside the visible window; their history page shows them.
      if (currentItem !== undefined) {
        if (
          (currentItem.type !== "run_interrupt_request" &&
            currentItem.type !== "approval_request" &&
            currentItem.type !== "user_input_request") ||
          !isOrchestrationV2TurnItemVisible({
            item: currentItem,
            runs: projection.runs,
            attempts: projection.attempts,
            items: projection.turnItems,
          })
        )
          continue;
        row = { ...row, item: currentItem };
      }
    }
    pageKeys.add(key);
    page.push(row);
    if (
      (row.visibility === "local" || row.sourceThreadId === projection.thread.id) &&
      !turnItemById.has(String(row.sourceItemId))
    )
      turnItemById.set(String(row.sourceItemId), row.item);
  }
  if (page.length === 0 && work === undefined) return projection;
  let visible: OrchestrationV2ProjectedTurnItem[];
  if (work && anchor && deferred) {
    let end = start + 1;
    while (end < projection.visibleTurnItems.length) {
      const row = projection.visibleTurnItems[end]!;
      if (
        row.sourceThreadId !== anchor.sourceThreadId ||
        row.visibility === "synthetic" ||
        row.item.ordinal > deferred.lastOrdinal
      )
        break;
      end += 1;
    }
    const item = { ...anchor.item };
    if (work.nextCursor === null) delete item.deferredWork;
    else item.deferredWork = { ...deferred, cursor: work.nextCursor };
    const updated = { ...anchor, item };
    const section = [
      ...page,
      ...projection.visibleTurnItems
        .slice(start, end)
        .filter((row) => !pageKeys.has(projectedItemKey(row))),
    ];
    const ordered = section
      .map((row) => (row.sourceItemId === anchor.sourceItemId ? updated : row))
      .sort((left, right) => left.item.ordinal - right.item.ordinal);
    visible = [
      ...projection.visibleTurnItems.slice(0, start),
      ...ordered,
      ...projection.visibleTurnItems.slice(end),
    ];
    if (anchor.visibility === "local") turnItemById.set(String(updated.item.id), updated.item);
  } else {
    visible = [
      ...page,
      ...projection.visibleTurnItems.filter((row) => !pageKeys.has(projectedItemKey(row))),
    ];
  }
  if (
    visible.length === projection.visibleTurnItems.length &&
    visible.every((row, index) => row === projection.visibleTurnItems[index])
  )
    return projection;
  return {
    ...projection,
    turnItems: [...turnItemById.values()],
    visibleTurnItems: renumberVisible(visible),
  };
}

export function applyHistoryPageMeta(
  current: ThreadHistoryMeta,
  page: {
    readonly nextCursor: string | null;
    readonly hasMoreHistory: boolean;
  },
  addedUserTurns: number,
): ThreadHistoryMeta {
  return {
    historyCursor: page.nextCursor,
    hasMoreHistory: page.hasMoreHistory,
    loading: false,
    error: null,
    expanded: true,
    latestLocalTurnOrdinal: current.latestLocalTurnOrdinal,
    userTurnsBeforeWindow: withOlderUserTurns(current.userTurnsBeforeWindow, addedUserTurns),
  };
}

/** The count once `added` earlier prompts joined the window. */
export function withOlderUserTurns(before: number | null, added: number): number | null {
  return before === null ? null : Math.max(0, before - added);
}

export function countUserTurnStarts(rows: ReadonlyArray<TurnRow>): number {
  let count = 0;
  for (const row of rows) if (isOrchestrationV2UserTurnStart(row.item)) count += 1;
  return count;
}

const NO_TURN_NUMBERS: ReadonlyMap<MessageId, number> = new Map();
const turnNumbersCache = new WeakMap<
  ReadonlyArray<TurnRow>,
  { readonly before: number; readonly numbers: ReadonlyMap<MessageId, number> }
>();

/** Each shown prompt's "Turn N", counting on from the `before` prompts that precede the rows. */
export function userTurnNumbers(
  rows: ReadonlyArray<TurnRow>,
  before: number | null,
): ReadonlyMap<MessageId, number> {
  if (before === null) return NO_TURN_NUMBERS;
  const cached = turnNumbersCache.get(rows);
  if (cached?.before === before) return cached.numbers;
  const numbers = new Map<MessageId, number>();
  let turn = before;
  for (const { item } of rows) {
    if (item.type !== "user_message" || !isOrchestrationV2UserTurnStart(item)) continue;
    turn += 1;
    numbers.set(item.messageId, turn);
  }
  turnNumbersCache.set(rows, { before, numbers });
  return numbers;
}

export function shouldShowLoadEarlierControl(history: ThreadHistoryMeta): boolean {
  return history.hasMoreHistory || history.error !== null;
}
