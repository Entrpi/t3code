import { describe } from "@effect/vitest";

import { CursorOrchestratorReplayHarness } from "../Adapters/CursorAdapterV2.testkit.ts";
import { itRunsReplayFixtures, runReplayFixture } from "./ProviderReplayFixtures.ts";

describe("Cursor replay fixtures", () => {
  itRunsReplayFixtures("cursor", (input) =>
    runReplayFixture({ ...input, harness: CursorOrchestratorReplayHarness }),
  );
});
