import {
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { ThreadSubsessionState } from "@t3tools/client-runtime/state/subsessions";
import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import type { MenuAction } from "@react-native-menu/menu";
import * as Haptics from "expo-haptics";

import * as Dialog from "../../components/ui/Dialog";
import { appAtomRegistry } from "../../state/atom-registry";
import { readEnvironmentScope } from "../../state/session";
import { threadEnvironment } from "../../state/threads";

export type SubsessionAction = "detach" | "reattach" | "group-with-parent" | "separate-from-parent";

/** The same choices as the web thread menu. */
export function subsessionMenuActions(state: ThreadSubsessionState): MenuAction[] {
  if (state === "attached") {
    return [{ id: "detach", title: "Detach to top level", image: "arrow.up.right" }];
  }
  if (state === null) return [];
  return [
    { id: "reattach", title: "Reattach to parent", image: "arrow.turn.left.up" },
    state === "detached-grouped"
      ? { id: "separate-from-parent", title: "Separate from parent", image: "square.split.2x1" }
      : { id: "group-with-parent", title: "Group with parent", image: "square.on.square" },
  ];
}

export function isSubsessionAction(event: string): event is SubsessionAction {
  return (
    event === "detach" ||
    event === "reattach" ||
    event === "group-with-parent" ||
    event === "separate-from-parent"
  );
}

// Mobile has no client settings, so Detach keeps web's default and stays grouped.
export async function organizeSubsession(
  thread: EnvironmentThreadShell,
  action: SubsessionAction,
): Promise<void> {
  const title = action === "reattach" ? "Could not reattach thread" : "Could not detach thread";
  if (!readEnvironmentScope(thread.environmentId, AuthOrchestrationOperateScope)) {
    Dialog.alert(title, "This connection cannot change threads.");
    return;
  }
  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  const input = { threadId: thread.id };
  const result =
    action === "reattach"
      ? await runAtomCommand(
          appAtomRegistry,
          threadEnvironment.reattach,
          { environmentId: thread.environmentId, input },
          { reportFailure: false },
        )
      : await runAtomCommand(
          appAtomRegistry,
          threadEnvironment.detach,
          {
            environmentId: thread.environmentId,
            input: { ...input, grouped: action !== "separate-from-parent" },
          },
          { reportFailure: false },
        );
  if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
    const error = squashAtomCommandFailure(result);
    Dialog.alert(title, error instanceof Error ? error.message : "Try again.");
  }
}
