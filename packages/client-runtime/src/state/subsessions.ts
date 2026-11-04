import {
  isListedThreadLineage,
  isSubsessionThread,
  subagentOriginOf,
  type OrchestrationV2ThreadShell,
  type ThreadId,
} from "@t3tools/contracts";

import { scopeThreadRef, scopedThreadKey } from "../environment/scoped.ts";
import type { EnvironmentThreadShell } from "./models.ts";
import { isThreadWorking } from "./threadInbox.ts";

/** Settled subsessions are listed with settled threads; open ones only under their parent. */
export const isSettledSubsession = (
  thread: Pick<EnvironmentThreadShell, "settledOverride" | "source">,
): boolean => thread.settledOverride === "settled" && isSubsessionThread(thread.source);

/** Whether a thread has its own row in a thread list. */
export const isListedThread = (
  thread: Pick<EnvironmentThreadShell, "lineage" | "settledOverride" | "source">,
): boolean => isListedThreadLineage(thread.lineage) || isSettledSubsession(thread);

/**
 * How many of a session's own subagents are working or waiting now. They run inside its turn or
 * as its background work, so its shell names them without reading their threads.
 */
export function activeSubagentCount(
  thread: Pick<EnvironmentThreadShell, "workingSubagents" | "pendingBackgroundTasks">,
): number {
  const ids = new Set<string>();
  for (const working of thread.workingSubagents ?? []) {
    if (working.origin === "provider_native") ids.add(working.threadId);
  }
  for (const task of thread.pendingBackgroundTasks) {
    // Providers report their own background agents without an origin.
    if (task.kind === "subagent" && (task.origin ?? "provider_native") === "provider_native") {
      ids.add(task.childThreadId ?? task.taskId);
    }
  }
  return ids.size;
}

const isOpenSubsessionOf = (
  parentId: ThreadId,
  thread: Pick<EnvironmentThreadShell, "lineage" | "archivedAt" | "settledOverride" | "source">,
) =>
  thread.lineage.parentThreadId === parentId &&
  isSubsessionThread(thread.source) &&
  thread.archivedAt === null &&
  thread.settledOverride !== "settled";

export type SubsessionState = "waiting" | "working";

export interface SubsessionNode {
  readonly thread: EnvironmentThreadShell;
  readonly children: ReadonlyArray<SubsessionNode>;
  /** The most urgent state among the row's descendants, shown while it is collapsed. */
  readonly descendantState: SubsessionState | null;
}

export function subsessionState(thread: EnvironmentThreadShell): SubsessionState | null {
  if (thread.hasPendingApprovals || thread.hasPendingUserInput) return "waiting";
  return isThreadWorking(thread) ? "working" : null;
}

export const moreUrgentSubsessionState = (
  left: SubsessionState | null,
  right: SubsessionState | null,
): SubsessionState | null =>
  left === "waiting" || right === "waiting" ? "waiting" : (left ?? right);

/**
 * A thread's open subsessions under its card, each with its own, most recently active first.
 * Idle ones are only in the family read; the shell's own copies are fresher. Settled ones are
 * listed with settled threads, and their open subsessions go with them.
 */
export function subsessionTree(
  parentId: ThreadId,
  known: ReadonlyArray<EnvironmentThreadShell>,
  family: ReadonlyArray<EnvironmentThreadShell>,
): SubsessionNode[] {
  const byId = new Map<string, EnvironmentThreadShell>();
  for (const thread of [...family, ...known]) byId.set(thread.id, thread);
  const threads = [...byId.values()];
  const visited = new Set<ThreadId>([parentId]);
  const branch = (id: ThreadId): SubsessionNode[] =>
    threads
      .filter((thread) => isOpenSubsessionOf(id, thread) && !visited.has(thread.id))
      .sort(
        (left, right) =>
          Date.parse(right.latestUserMessageAt ?? right.updatedAt) -
          Date.parse(left.latestUserMessageAt ?? left.updatedAt),
      )
      .map((thread) => {
        visited.add(thread.id);
        const children = branch(thread.id);
        return {
          thread,
          children,
          descendantState: children.reduce<SubsessionState | null>(
            (state, child) =>
              moreUrgentSubsessionState(
                state,
                moreUrgentSubsessionState(subsessionState(child.thread), child.descendantState),
              ),
            null,
          ),
        };
      });
  return branch(parentId);
}

/** The shell's subsessions under the key of every ancestor up to the first one that isn't one. */
export function subsessionDescendants(
  threads: ReadonlyArray<EnvironmentThreadShell>,
): Map<string, EnvironmentThreadShell[]> {
  // The walk stops at the first ancestor that isn't a subsession, so only subsessions need indexing.
  const subsessions = threads.filter((thread) => isSubsessionThread(thread.source));
  const byId = new Map(
    subsessions.map((thread) => [
      scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
      thread,
    ]),
  );
  const byAncestor = new Map<string, EnvironmentThreadShell[]>();
  for (const thread of subsessions) {
    const visited = new Set<string>();
    let parentId = thread.lineage.parentThreadId;
    while (parentId !== null) {
      const key = scopedThreadKey(scopeThreadRef(thread.environmentId, parentId));
      if (visited.has(key)) break;
      visited.add(key);
      const rows = byAncestor.get(key);
      if (rows === undefined) byAncestor.set(key, [thread]);
      else rows.push(thread);
      const ancestor = byId.get(key);
      if (ancestor === undefined) break;
      parentId = ancestor.lineage.parentThreadId;
    }
  }
  return byAncestor;
}

/** Where a delegated subsession stands: under its parent, or detached beside or apart from it. */
export type ThreadSubsessionState = "attached" | "detached-grouped" | "detached-separate" | null;

export function threadSubsessionState(
  thread: Pick<OrchestrationV2ThreadShell, "lineage" | "creationSource" | "forkedFrom">,
): ThreadSubsessionState {
  if (thread.lineage.detachedFrom !== undefined) {
    return thread.lineage.groupThreadId === undefined ? "detached-grouped" : "detached-separate";
  }
  return thread.lineage.relationshipToParent === "subagent" &&
    subagentOriginOf(thread.creationSource) === "app_owned" &&
    thread.forkedFrom?.type === "node"
    ? "attached"
    : null;
}

/**
 * Where a tree disagrees with the server's subsession counts, as one key. A family read lasts the
 * shell generation, so a changed key means it missed or kept a child and should be read again.
 */
export function subsessionCountMisses(
  nodes: ReadonlyArray<SubsessionNode>,
  parentId: ThreadId,
  expected: number,
): string {
  const misses = (level: ReadonlyArray<SubsessionNode>, id: ThreadId, count: number): string[] => [
    ...(level.length === count ? [] : [`${id}:${count}`]),
    ...level.flatMap((node) =>
      misses(
        node.children,
        node.thread.id,
        node.thread.subagentCounts?.appOwned ?? node.children.length,
      ),
    ),
  ];
  return misses(nodes, parentId, expected).join(",");
}
