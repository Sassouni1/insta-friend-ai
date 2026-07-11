import { describe, expect, it } from "vitest";
import { normalizePhoneForSuppression } from "../../supabase/functions/_shared/opt-out";

describe("normalizePhoneForSuppression", () => {
  it("normalizes a US ten-digit number", () => {
    expect(normalizePhoneForSuppression("(727) 637-4672"))
      .toBe("+17276374672");
  });

  it("preserves a country code", () => {
    expect(normalizePhoneForSuppression("+44 20 7946 0958"))
      .toBe("+442079460958");
  });
});
