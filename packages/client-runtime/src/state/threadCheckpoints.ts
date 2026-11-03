import type {
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  MessageId,
  OrchestrationV2CheckpointFileTotals,
  OrchestrationV2ProviderTurn,
  OrchestrationV2ThreadProjection,
  RunAttemptId,
  RunId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import type { ThreadStructure } from "./models.ts";

export interface ThreadCheckpointSummary {
  readonly checkpointId?: CheckpointId;
  readonly scopeId?: CheckpointScopeId;
  readonly runId: RunId;
  readonly checkpointTurnCount: number;
  readonly checkpointRef: CheckpointRef;
  readonly status: "ready" | "missing" | "error" | "stale";
  /** A prefix of the changed files when `filesTotal` is set; see `checkpointFileTotals`. */
  readonly files: ReadonlyArray<{
    readonly path: string;
    readonly kind: string;
    readonly additions: number;
    readonly deletions: number;
  }>;
  readonly filesTotal?: OrchestrationV2CheckpointFileTotals;
  readonly assistantMessageId: MessageId | null;
  readonly completedAt: string;
}

export function deriveThreadCheckpointSummaries(
  projection: Pick<OrchestrationV2ThreadProjection, "checkpoints" | "messages">,
): ReadonlyArray<ThreadCheckpointSummary> {
  let assistantMessageIdsByRun: Map<RunId, MessageId | null | undefined> | undefined;
  let nextMessageIndex = -1;
  return projection.checkpoints.flatMap((checkpoint) => {
    if (checkpoint.appRunOrdinal === null || checkpoint.runId === null) return [];
    const messages = projection.messages;
    if (assistantMessageIdsByRun === undefined) {
      assistantMessageIdsByRun = new Map();
      for (const entry of projection.checkpoints) {
        if (entry.appRunOrdinal !== null && entry.runId !== null) {
          assistantMessageIdsByRun.set(entry.runId, undefined);
        }
      }
      nextMessageIndex = messages.length - 1;
    }
    // Resume the reverse scan only as far as this checkpoint needs. Recent
    // checkpoints must not force a traversal of unrelated older history.
    while (nextMessageIndex >= 0 && assistantMessageIdsByRun.get(checkpoint.runId) === undefined) {
      const message = messages[nextMessageIndex--]!;
      const { runId, role } = message;
      if (
        role === "assistant" &&
        runId !== null &&
        assistantMessageIdsByRun.has(runId) &&
        assistantMessageIdsByRun.get(runId) === undefined
      ) {
        assistantMessageIdsByRun.set(runId, message.id ?? null);
      }
    }
    const assistantMessageId = assistantMessageIdsByRun.get(checkpoint.runId) ?? null;
    return [
      {
        checkpointId: checkpoint.id,
        scopeId: checkpoint.scopeId,
        runId: checkpoint.runId,
        checkpointTurnCount: checkpoint.appRunOrdinal,
        checkpointRef: checkpoint.ref,
        status: checkpoint.status,
        files: checkpoint.files,
        ...(checkpoint.filesTotal === undefined ? {} : { filesTotal: checkpoint.filesTotal }),
        assistantMessageId,
        completedAt: DateTime.formatIso(checkpoint.capturedAt),
      },
    ];
  });
}

export function checkpointFileTotals(
  checkpoint: Pick<ThreadCheckpointSummary, "files" | "filesTotal">,
): OrchestrationV2CheckpointFileTotals {
  if (checkpoint.filesTotal !== undefined) return checkpoint.filesTotal;
  let additions = 0;
  let deletions = 0;
  for (const file of checkpoint.files) {
    additions += file.additions;
    deletions += file.deletions;
  }
  return { count: checkpoint.files.length, additions, deletions };
}

/**
 * Run ordinals the conversation can be reverted to: those whose provider turn belongs to the
 * active provider thread, plus 0 for the thread start. Empty without a live provider session
 * on the thread's selected instance.
 */
export function deriveAvailableRevertTurnCounts(projection: ThreadStructure | null) {
  const available = new Set<number>();
  const providerThread = projection?.providerThreads.find(
    (candidate) => candidate.id === projection.thread.activeProviderThreadId,
  );
  if (
    !providerThread?.providerSessionId ||
    providerThread.providerInstanceId !== projection?.thread.modelSelection.instanceId
  )
    return available;
  available.add(0);
  const attemptsById = new Map(projection.attempts.map((attempt) => [attempt.id, attempt]));
  const providerTurnsById = new Map<
    OrchestrationV2ProviderTurn["id"],
    OrchestrationV2ProviderTurn
  >();
  const latestTurnByAttempt = new Map<RunAttemptId, OrchestrationV2ProviderTurn>();
  for (const turn of projection.providerTurns) {
    providerTurnsById.set(turn.id, turn);
    if (turn.runAttemptId === null) continue;
    const latest = latestTurnByAttempt.get(turn.runAttemptId);
    if (latest === undefined || turn.ordinal > latest.ordinal) {
      latestTurnByAttempt.set(turn.runAttemptId, turn);
    }
  }
  for (const run of projection.runs) {
    if (run.activeAttemptId === null) continue;
    const attempt = attemptsById.get(run.activeAttemptId);
    const providerTurn =
      latestTurnByAttempt.get(run.activeAttemptId) ??
      (attempt?.providerTurnId == null ? undefined : providerTurnsById.get(attempt.providerTurnId));
    // A ready file checkpoint alone cannot restore the provider conversation.
    if (providerTurn?.providerThreadId === providerThread.id) available.add(run.ordinal);
  }
  return available;
}

/**
 * Where Edit from here on each run's prompt rewinds to: the run before it that was kept (0 for
 * the thread start), when that point has a ready checkpoint and the conversation can return to it.
 */
export function deriveRewindTurnCountByRunId(
  projection: ThreadStructure | null,
): ReadonlyMap<RunId, number> {
  const targets = new Map<RunId, number>();
  if (projection === null) return targets;
  const available = deriveAvailableRevertTurnCounts(projection);
  const ready = new Set<number>();
  for (const checkpoint of projection.checkpoints) {
    if (checkpoint.status !== "ready") continue;
    if (checkpoint.appRunOrdinal !== null) ready.add(checkpoint.appRunOrdinal);
    else if (checkpoint.ordinalWithinScope === 0) ready.add(0);
  }
  let previous = 0;
  for (const run of [...projection.runs].sort((left, right) => left.ordinal - right.ordinal)) {
    if (run.status === "rolled_back") continue;
    if (available.has(previous) && ready.has(previous)) targets.set(run.id, previous);
    previous = run.ordinal;
  }
  return targets;
}
