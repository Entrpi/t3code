import { describe, expect, it } from "vite-plus/test";

import {
  activeTurnActionLabel,
  activeTurnSteering,
  alternateComposerDispatchAction,
  resolveComposerDispatchMode,
} from "./composerDispatch.ts";

const turns = (input: {
  readonly active: boolean;
  readonly cancelsTools?: boolean;
  readonly restart: boolean;
  readonly interrupt?: boolean;
}) =>
  ({
    supportsActiveSteering: input.active,
    ...(input.cancelsTools === undefined
      ? {}
      : { activeSteeringInterruptsTools: input.cancelsTools }),
    supportsSteeringByInterruptRestart: input.restart,
    supportsInterrupt: input.interrupt ?? true,
  }) as never;

describe("composer dispatch", () => {
  it.each([
    ["Codex", turns({ active: true, restart: true }), "joins"],
    ["Kiro", turns({ active: true, cancelsTools: false, restart: false }), "joins"],
    ["Claude", turns({ active: true, cancelsTools: true, restart: false }), "cancels-tools"],
    ["Cursor and ACP agents", turns({ active: false, restart: true }), "restarts"],
    [
      "a provider that cannot interrupt",
      turns({ active: false, restart: true, interrupt: false }),
      "none",
    ],
    ["the ACP registry", turns({ active: false, restart: false }), "none"],
  ])("derives how %s takes a message mid-turn", (_, capabilities, steering) => {
    expect(activeTurnSteering(capabilities)).toBe(steering);
  });

  it.each([
    ["joins", "steer", "steer", "queue"],
    ["joins", "queue", "queue", "steer"],
    ["cancels-tools", "steer", "queue", "steer"],
    ["restarts", "steer", "queue", "restart"],
    ["none", "steer", "queue", null],
  ] as const)(
    "with %s steering and a %s default, sends %s and offers %s",
    (steering, activeTurnDefault, primary, alternate) => {
      expect(
        resolveComposerDispatchMode({
          running: true,
          alternateModifier: false,
          activeTurnDefault,
          steering,
        }),
      ).toBe(primary);
      expect(alternateComposerDispatchAction(activeTurnDefault, steering)).toBe(alternate);
    },
  );

  it("names every action that stops work Interrupt and send", () => {
    expect(activeTurnActionLabel("steer", "joins")).toBe("Steer");
    expect(activeTurnActionLabel("steer", "cancels-tools")).toBe("Interrupt and send");
    expect(activeTurnActionLabel("restart", "restarts")).toBe("Interrupt and send");
  });
});
