import { backoffIfRateLimited } from "./rate-limit-backoff";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("backoffIfRateLimited", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not wait when the remaining quota is comfortably above the threshold", async () => {
    const started = Date.now();
    await backoffIfRateLimited({ "x-ratelimit-remaining": "500" });
    expect(Date.now() - started).toBeLessThan(50);
  });

  it("does not wait when the header is missing entirely", async () => {
    const started = Date.now();
    await backoffIfRateLimited({});
    expect(Date.now() - started).toBeLessThan(50);
  });

  it("waits before returning when the remaining quota is low", async () => {
    vi.useFakeTimers();
    const onBackoff = vi.fn();
    const call = backoffIfRateLimited({ "x-ratelimit-remaining": "3" }, onBackoff);

    let resolved = false;
    void call.then(() => {
      resolved = true;
    });

    await Promise.resolve(); // let the microtask queue settle
    expect(resolved).toBe(false); // still waiting, hasn't slept yet
    expect(onBackoff).toHaveBeenCalledWith(3);

    vi.advanceTimersByTime(2000);
    await call;
    expect(resolved).toBe(true);
  });
});
