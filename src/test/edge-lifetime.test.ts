import { describe, expect, it, vi } from "vitest";

import { registerEdgeLifetime } from "../../supabase/functions/_shared/edge-lifetime";

describe("registerEdgeLifetime", () => {
  it("registers one unresolved promise and releases it exactly once", async () => {
    const waitUntil = vi.fn();
    const lifetime = registerEdgeLifetime({ waitUntil });

    expect(lifetime.registered).toBe(true);
    expect(waitUntil).toHaveBeenCalledTimes(1);
    expect(waitUntil).toHaveBeenCalledWith(lifetime.promise);

    let settled = false;
    void lifetime.promise.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    expect(lifetime.resolve()).toBe(true);
    await lifetime.promise;
    expect(settled).toBe(true);
    expect(lifetime.resolve()).toBe(false);
  });

  it("remains usable in local runtimes that do not expose EdgeRuntime", async () => {
    const lifetime = registerEdgeLifetime();

    expect(lifetime.registered).toBe(false);
    expect(lifetime.resolve()).toBe(true);
    await expect(lifetime.promise).resolves.toBeUndefined();
  });
});
