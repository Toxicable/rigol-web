import { describe, expect, it, vi } from "vitest";

import {
  waitForOfflineThenOnline,
  type ReachabilityDelay,
  type TcpProbe,
} from "./tcp-reachability-monitor.js";

describe("waitForOfflineThenOnline", () => {
  it("waits for an offline transition before accepting reachability as physical wake", async () => {
    const states = [true, true, false, false, true];
    const probe = vi.fn<TcpProbe>(async () => states.shift() ?? true);
    const wait = vi.fn<ReachabilityDelay>(async () => undefined);
    const controller = new AbortController();

    await expect(
      waitForOfflineThenOnline("scope.test", 5555, controller.signal, probe, wait),
    ).resolves.toBe(true);

    expect(probe).toHaveBeenCalledTimes(5);
    expect(wait).toHaveBeenCalledTimes(4);
    expect(wait).toHaveBeenCalledWith(2_000);
  });

  it("stops without reporting wake when aborted", async () => {
    const controller = new AbortController();
    const probe = vi.fn<TcpProbe>(async () => false);
    const wait = vi.fn<ReachabilityDelay>(async () => {
      controller.abort();
    });

    await expect(
      waitForOfflineThenOnline("scope.test", 5555, controller.signal, probe, wait),
    ).resolves.toBe(false);

    expect(probe).toHaveBeenCalledOnce();
  });
});
