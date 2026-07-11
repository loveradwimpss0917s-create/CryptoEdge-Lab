import { describe, expect, it } from "vitest";
import { nextActionLabel } from "./labels";
import type { Readiness } from "../api/client";

const FULL_DONE_READINESS: Readiness = { state: "FULL_DONE", missing: {} };

describe("nextActionLabel FULL_DONE (2026-07 fix: verdict-aware hint)", () => {
  // Previously this always returned the same "TESTING→VALIDATEDを判断"
  // text regardless of the actual verdict -- misleading when verdict is
  // REJECT/WATCH, since TESTING->VALIDATED's guard (docs/05 §2) requires
  // verdict===ADOPT and will always reject those cases (found live: user
  // report of "月曜アジア開場効果", verdict=REJECT, confused by this text
  // pointing at a transition that could never succeed).

  it("suggests VALIDATED when the latest full run's verdict is ADOPT", () => {
    expect(nextActionLabel(FULL_DONE_READINESS, "ADOPT")).toContain("VALIDATED");
  });

  it("suggests REJECTED (not VALIDATED) when the latest full run's verdict is REJECT", () => {
    const label = nextActionLabel(FULL_DONE_READINESS, "REJECT");
    expect(label).toContain("却下");
    expect(label).not.toContain("VALIDATEDへ");
  });

  it("suggests REJECTED (not VALIDATED) when the latest full run's verdict is WATCH", () => {
    const label = nextActionLabel(FULL_DONE_READINESS, "WATCH");
    expect(label).toContain("却下");
    expect(label).not.toContain("VALIDATEDへ");
  });

  it("falls back to the generic text when no verdict is available", () => {
    expect(nextActionLabel(FULL_DONE_READINESS, null)).toBe("verdictをレビュー → TESTING→VALIDATEDを判断");
  });
});
