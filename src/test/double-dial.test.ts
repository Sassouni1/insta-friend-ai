import { describe, expect, it } from "vitest";
import {
  isVerifiedNoAnswer,
  normalizeCallFailureReason,
} from "../../supabase/functions/_shared/double-dial";

describe("double dial no-answer classification", () => {
  it("accepts only normalized no-answer outcomes", () => {
    expect(isVerifiedNoAnswer("no-answer")).toBe(true);
    expect(isVerifiedNoAnswer("NO_ANSWER")).toBe(true);
    expect(isVerifiedNoAnswer("no answer")).toBe(true);
  });

  it("rejects every answered or non-answer failure class", () => {
    for (const reason of [
      "busy",
      "rejected",
      "voicemail",
      "unknown",
      "technical-failure",
      "Client disconnected: 1000",
      null,
    ]) {
      expect(isVerifiedNoAnswer(reason)).toBe(false);
    }
  });

  it("normalizes provider formatting without broad matching", () => {
    expect(normalizeCallFailureReason("  NO ANSWER ")).toBe("no-answer");
  });
});
