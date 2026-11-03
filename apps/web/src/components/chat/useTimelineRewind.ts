import type { EnvironmentThreadShell, ThreadStructure } from "@t3tools/client-runtime/state/shell";
import type { ComposerThreadTarget } from "../../composerDraftStore";
import type { ComposerHandleRef } from "../../composerHandleContext";
import type { SessionPhase } from "../../types";
import { useStableCallback } from "../../hooks/useStableCallback";
import {
  AuthOrchestrationOperateScope,
  CommandId,
  type EnvironmentId,
  type MessageId,
  type ScopedThreadRef,
  type ThreadId,
  type RunId,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useNavigate } from "@tanstack/react-router";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { readLocalApi } from "../../localApi";
import { findRevertCheckpoint } from "../../session-logic";
import { type ChatMessage } from "../../types";
import { newMessageId, newThreadId, randomUUID } from "~/lib/utils";
import { restoreAttachmentOnlyBootstrapPrompt } from "@t3tools/shared/composerContextReferences";
import * as Option from "effect/Option";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { buildThreadRouteParams } from "../../threadRoutes";
import { useComposerDraftStore } from "../../composerDraftStore";
import { environmentThreadDetails, threadEnvironment } from "../../state/threads";
import { waitForThreadShell } from "../../state/entities";
import { openRevertConfirm } from "./ChatOverlayHosts";
import { assetEnvironment } from "../../state/assets";
import { readEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import { rewindToMessage } from "./chatViewSend";
import { makeThreadErrorSetter, waitForRollbackFollowUp } from "../ChatView.logic";
interface TimelineRewindInput {
  readonly environmentId: EnvironmentId;
  readonly routeThreadRef: ScopedThreadRef;
  readonly routeThreadKey: string;
  readonly currentRouteThreadKeyRef: { readonly current: string | null };
  readonly serverProjection: ThreadStructure | null;
  readonly activeThread: EnvironmentThreadShell | undefined;
  readonly timelineMessages: ReadonlyArray<ChatMessage>;
  readonly phase: SessionPhase;
  readonly isSendBusy: boolean;
  readonly isRevertingCheckpoint: boolean;
  readonly supportsConversationRollback: boolean;
  readonly activeEnvironmentUnavailable: boolean;
  readonly activeEnvironmentUnavailableLabel: string | null;
  readonly promptRef: { current: string };
  readonly composerRef: ComposerHandleRef;
  readonly composerDraftTarget: ComposerThreadTarget;
  readonly setThreadError: ReturnType<typeof makeThreadErrorSetter>;
}

/**
 * Going back in a thread's timeline: reverting to an earlier turn (restoring that message into
 * the composer) and forking a new thread from a run.
 */
export function useTimelineRewind(input: TimelineRewindInput) {
  const {
    environmentId,
    routeThreadRef,
    routeThreadKey,
    currentRouteThreadKeyRef,
    serverProjection,
    activeThread,
    timelineMessages,
    phase,
    isSendBusy,
    isRevertingCheckpoint,
    supportsConversationRollback,
    activeEnvironmentUnavailable,
    activeEnvironmentUnavailableLabel,
    promptRef,
    composerRef,
    composerDraftTarget,
    setThreadError,
  } = input;
  const navigate = useNavigate();
  const createAttachmentAssetUrl = useAtomQueryRunner(assetEnvironment.createUrl, {
    reportFailure: false,
    refresh: true,
  });

  const revertThreadCheckpoint = useOrchestrationCommand(threadEnvironment.revertCheckpoint, {
    reportFailure: false,
  });
  const forkThreadFromRun = useAtomCommand(threadEnvironment.forkFromRun, {
    reportFailure: false,
  });

  const setRewinding = (rewinding: boolean) =>
    useComposerDraftStore.setState((store) => {
      const keys = new Set(store.rewindingThreadKeys);
      if (rewinding) keys.add(routeThreadKey);
      else keys.delete(routeThreadKey);
      return { rewindingThreadKeys: keys };
    });
  const showComposerPrompt = (nextPrompt: string) => {
    if (currentRouteThreadKeyRef.current !== routeThreadKey) return;
    promptRef.current = nextPrompt;
    composerRef.current?.resetCursorState({ prompt: nextPrompt, cursor: nextPrompt.length });
    requestAnimationFrame(() => {
      if (currentRouteThreadKeyRef.current === routeThreadKey) composerRef.current?.focusAtEnd();
    });
  };

  const onRevertToTurnCount = async (
    turnCount: number,
    messageId: MessageId,
    restoreFiles?: boolean,
  ) => {
    const localApi = readLocalApi();
    if (
      !localApi ||
      !activeThread ||
      isRevertingCheckpoint ||
      !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)
    )
      return;
    const message = timelineMessages.find((message) => message.id === messageId);
    if (!message || message.role !== "user") return;

    if (!supportsConversationRollback) {
      setThreadError(
        activeThread.id,
        "This provider does not support reverting conversation history. Start a new thread instead.",
      );
      return;
    }
    if (activeEnvironmentUnavailable && activeEnvironmentUnavailableLabel) {
      setThreadError(
        activeThread.id,
        `Reconnect ${activeEnvironmentUnavailableLabel} before reverting checkpoints.`,
      );
      return;
    }
    if (phase === "running" || isSendBusy) {
      setThreadError(activeThread.id, "Interrupt the current turn before reverting checkpoints.");
      return;
    }
    if (restoreFiles === undefined) {
      openRevertConfirm(routeThreadKey, { turnCount, messageId });
      return;
    }

    setRewinding(true);
    setThreadError(activeThread.id, null);
    const rewind = await rewindToMessage({
      message,
      environmentId,
      routeThreadRef,
      threadId: activeThread.id,
      turnCount,
      restoreFiles,
      // Keep the live checkpoint identity when command context refetches a bounded window.
      checkpoint: findRevertCheckpoint(serverProjection?.checkpoints ?? [], turnCount),
      draftTarget: composerDraftTarget,
      composerHasPendingAttachments: composerRef.current?.hasPendingAttachments() === true,
      createAssetUrl: createAttachmentAssetUrl,
      revertThreadCheckpoint,
    });
    setRewinding(false);
    if (rewind.error !== null) {
      setThreadError(activeThread.id, rewind.error);
      return;
    }
    showComposerPrompt(rewind.prompt);
  };
  const onRevertToTurnCountStable = useStableCallback(onRevertToTurnCount);
  const onConfirmRevert = (turnCount: number, messageId: MessageId, restoreFiles: boolean) => {
    void onRevertToTurnCount(turnCount, messageId, restoreFiles);
  };
  const onConfirmRevertStable = useStableCallback(onConfirmRevert);

  const onEditPrompt = async (
    turnCount: number,
    messageId: MessageId,
    text: string,
  ): Promise<string | null> => {
    if (!activeThread || isRevertingCheckpoint) return "Wait for the thread to settle.";
    if (!readEnvironmentScope(environmentId, AuthOrchestrationOperateScope))
      return "You can't edit messages in this thread.";
    if (activeEnvironmentUnavailable && activeEnvironmentUnavailableLabel)
      return `Reconnect ${activeEnvironmentUnavailableLabel} before editing.`;
    if (phase === "running" || isSendBusy) return "Interrupt the current turn before editing.";
    const message = serverProjection?.messages.find((candidate) => candidate.id === messageId);
    if (!message) return "Reload the thread to edit this message.";
    const commandId = CommandId.make(randomUUID());
    const followUpMessageId = newMessageId();
    const checkpoint = findRevertCheckpoint(serverProjection?.checkpoints ?? [], turnCount);
    const threadId = activeThread.id;
    setRewinding(true);
    setThreadError(threadId, null);
    const failure = await waitForRollbackFollowUp(
      routeThreadRef,
      commandId,
      followUpMessageId,
      async () => {
        const result = await revertThreadCheckpoint({
          environmentId,
          input: {
            commandId,
            threadId,
            turnCount,
            // Inline Edit has no confirmation, so it keeps workspace files as they are.
            restoreFiles: false,
            ...(checkpoint === undefined
              ? {}
              : { checkpointId: checkpoint.id, scopeId: checkpoint.scopeId }),
            followUp: {
              messageId: followUpMessageId,
              text: restoreAttachmentOnlyBootstrapPrompt(
                text.trim(),
                message.attachments.length > 0,
              ),
              ...(message.context === undefined ? {} : { context: message.context }),
              attachments: message.attachments,
            },
          },
        });
        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      },
    ).then(
      () => null,
      (error: unknown) => (error instanceof Error ? error.message : "Could not edit this message."),
    );
    setRewinding(false);
    if (failure === null) return null;
    // A rewind that landed took the message, and its editor, with it.
    const run = Option.getOrNull(
      appAtomRegistry.get(environmentThreadDetails.stateAtom(routeThreadRef)).data,
    )?.runs.find((candidate) => candidate.id === message.runId);
    if (run?.status === "rolled_back") {
      const draft = useComposerDraftStore.getState();
      const current = draft.getComposerDraft(composerDraftTarget)?.prompt ?? "";
      const nextPrompt = current.length > 0 ? `${current}\n\n${text.trim()}` : text.trim();
      draft.setPrompt(composerDraftTarget, nextPrompt);
      showComposerPrompt(nextPrompt);
      setThreadError(threadId, failure);
    }
    return failure;
  };
  const onEditPromptStable = useStableCallback(onEditPrompt);

  const onForkFromRun = async (input: {
    readonly sourceThreadId: ThreadId;
    readonly runId: RunId;
  }) => {
    if (!activeThread || activeEnvironmentUnavailable) return;
    const targetThreadId = newThreadId();
    const targetThreadRef = scopeThreadRef(environmentId, targetThreadId);
    const result = await forkThreadFromRun({
      environmentId,
      input: {
        sourceThreadId: input.sourceThreadId,
        targetThreadId,
        runId: input.runId,
        title: `${activeThread.title} fork`,
      },
    });
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        setThreadError(
          activeThread.id,
          error instanceof Error ? error.message : "Failed to fork this response.",
        );
      }
      return;
    }
    const targetThreadReady = await waitForThreadShell(targetThreadRef);
    if (!targetThreadReady) {
      setThreadError(
        activeThread.id,
        "The fork was created, but its thread data did not reach this client. Reconnect and try opening it from the sidebar.",
      );
      return;
    }
    await navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(targetThreadRef),
    });
  };
  const onForkFromRunStable = useStableCallback(onForkFromRun);
  const onRevertTimelineTurn = (targetTurnCount: number, messageId: MessageId) => {
    void onRevertToTurnCountStable(targetTurnCount, messageId);
  };
  const onRevertTimelineTurnStable = useStableCallback(onRevertTimelineTurn);
  return {
    onConfirmRevertStable,
    onEditPromptStable,
    onForkFromRunStable,
    onRevertTimelineTurnStable,
  };
}
