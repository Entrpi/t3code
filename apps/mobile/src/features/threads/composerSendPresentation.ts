import {
  activeTurnActionLabel,
  alternateComposerDispatchAction,
  resolveComposerDispatchMode,
  type ActiveTurnComposerAction,
  type ActiveTurnSteering,
} from "@t3tools/client-runtime/state/composer-dispatch";

import type { FollowUpBehavior } from "../../lib/followUpBehavior";

export interface ComposerSendPresentation {
  readonly label: string;
  readonly icon:
    | "arrow.up"
    | "tray.and.arrow.up"
    | "checkmark"
    | "list.number"
    | "arrow.turn.left.up";
  readonly action: ActiveTurnComposerAction | null;
  readonly alternate: ActiveTurnComposerAction | null;
  readonly offersFollowUpChoice: boolean;
  readonly steering: ActiveTurnSteering;
}

export function resolveComposerSendPresentation(input: {
  readonly editingQueuedMessage: boolean;
  readonly running: boolean;
  readonly steering: ActiveTurnSteering;
  readonly followUpBehavior: FollowUpBehavior;
  readonly deliveryDeferred: boolean;
}): ComposerSendPresentation {
  const idle = { action: null, alternate: null, offersFollowUpChoice: false };
  if (input.editingQueuedMessage) {
    return {
      label: "Update queued message",
      icon: "checkmark",
      ...idle,
      steering: input.steering,
    };
  }
  if (!input.running) {
    return {
      label: input.deliveryDeferred ? "Queue" : "Send",
      icon: input.deliveryDeferred ? "tray.and.arrow.up" : "arrow.up",
      ...idle,
      steering: input.steering,
    };
  }
  const action = resolveComposerDispatchMode({
    running: true,
    alternateModifier: false,
    activeTurnDefault: input.followUpBehavior,
    steering: input.steering,
  }) as ActiveTurnComposerAction;
  const alternate = alternateComposerDispatchAction(input.followUpBehavior, input.steering);
  return {
    label: activeTurnActionLabel(action, input.steering),
    icon: action === "queue" ? "list.number" : "arrow.turn.left.up",
    action,
    alternate,
    offersFollowUpChoice: alternate !== null,
    steering: input.steering,
  };
}

/** The long-press menu's copy for one way to send while the agent works. */
export function followUpActionCopy(
  action: ActiveTurnComposerAction,
  steering: ActiveTurnSteering,
): { readonly title: string; readonly subtitle: string } {
  if (action === "queue") return { title: "Queue", subtitle: "Run after the current turn" };
  if (activeTurnActionLabel(action, steering) === "Steer") {
    return { title: "Steer now", subtitle: "Add to what the agent is doing" };
  }
  return {
    title: "Interrupt and send",
    subtitle:
      steering === "cancels-tools"
        ? "Stop running tools and send now"
        : "Stop the turn and start over with this message",
  };
}
