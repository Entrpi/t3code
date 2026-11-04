import type { OrchestrationV2ProviderCapabilities } from "@t3tools/contracts";

export type ComposerDispatchMode = "auto" | "queue" | "steer" | "restart";
export type ActiveTurnComposerAction = Exclude<ComposerDispatchMode, "auto">;

/**
 * How a message sent now reaches the running turn. Only `joins` adds it without stopping
 * anything: `cancels-tools` steers natively but cancels running tool calls, and `restarts`
 * interrupts the turn and starts it over. `none` can only queue.
 */
export type ActiveTurnSteering = "joins" | "cancels-tools" | "restarts" | "none";

export function activeTurnSteering(
  turns: OrchestrationV2ProviderCapabilities["turns"] | undefined,
): ActiveTurnSteering {
  // Without a session there is no turn to stop; the server queues a steer it cannot deliver.
  if (turns === undefined) return "joins";
  if (turns.supportsActiveSteering) {
    return turns.activeSteeringInterruptsTools === true ? "cancels-tools" : "joins";
  }
  return turns.supportsInterrupt && turns.supportsSteeringByInterruptRestart ? "restarts" : "none";
}

export function resolveComposerDispatchMode(input: {
  readonly running: boolean;
  readonly alternateModifier: boolean;
  readonly activeTurnDefault?: ActiveTurnComposerAction;
  /** `none` also while the active turn cannot take input, such as during compaction. */
  readonly steering?: ActiveTurnSteering;
}): ComposerDispatchMode {
  if (!input.running) return "auto";
  const steering = input.steering ?? "joins";
  if (steering === "none") return "queue";
  if (steering !== "joins") {
    // Stopping the agent's work to send is never the default.
    if (!input.alternateModifier) return "queue";
    return steering === "restarts" ? "restart" : "steer";
  }
  const defaultAction = input.activeTurnDefault ?? "steer";
  if (input.alternateModifier) return defaultAction === "queue" ? "steer" : "queue";
  return defaultAction;
}

/** The action the modifier switches to, or null when there is no other way to send. */
export function alternateComposerDispatchAction(
  activeTurnDefault?: ActiveTurnComposerAction,
  steering?: ActiveTurnSteering,
): ActiveTurnComposerAction | null {
  const input = {
    running: true,
    ...(activeTurnDefault === undefined ? {} : { activeTurnDefault }),
    ...(steering === undefined ? {} : { steering }),
  };
  const primary = resolveComposerDispatchMode({ ...input, alternateModifier: false });
  const alternate = resolveComposerDispatchMode({ ...input, alternateModifier: true });
  return alternate === primary ? null : (alternate as ActiveTurnComposerAction);
}

/** "Steer" only where the message joins the turn; anything that stops work says so. */
export function activeTurnActionLabel(
  action: ActiveTurnComposerAction,
  steering: ActiveTurnSteering,
): "Queue" | "Steer" | "Interrupt and send" {
  if (action === "queue") return "Queue";
  return action === "steer" && steering === "joins" ? "Steer" : "Interrupt and send";
}
