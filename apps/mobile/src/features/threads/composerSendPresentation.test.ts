import { describe, expect, it } from "vite-plus/test";

import { followUpActionCopy, resolveComposerSendPresentation } from "./composerSendPresentation";

const idle = {
  editingQueuedMessage: false,
  running: false,
  steering: "none",
  followUpBehavior: "queue",
  deliveryDeferred: false,
} as const;

describe("resolveComposerSendPresentation", () => {
  it("shows the outbox action when delivery is deferred", () => {
    const presentation = resolveComposerSendPresentation({ ...idle, deliveryDeferred: true });
    expect(presentation.label).toBe("Queue");
    expect(presentation.icon).toBe("tray.and.arrow.up");
    expect(resolveComposerSendPresentation(idle).icon).toBe("arrow.up");
  });

  it("never promises steering the provider cannot do", () => {
    const presentation = resolveComposerSendPresentation({
      ...idle,
      running: true,
      steering: "none",
      followUpBehavior: "steer",
    });

    expect(presentation.label).toBe("Queue");
    expect(presentation.action).toBe("queue");
    expect(presentation.alternate).toBeNull();
    expect(presentation.offersFollowUpChoice).toBe(false);
  });

  it.each([
    ["cancels-tools", "steer"],
    ["restarts", "restart"],
  ] as const)(
    "queues by default where steering %s, and offers Interrupt and send",
    (steering, alternate) => {
      const presentation = resolveComposerSendPresentation({
        ...idle,
        running: true,
        steering,
        followUpBehavior: "steer",
      });

      expect(presentation.label).toBe("Queue");
      expect(presentation.alternate).toBe(alternate);
      expect(followUpActionCopy(alternate, steering).title).toBe("Interrupt and send");
    },
  );
});
