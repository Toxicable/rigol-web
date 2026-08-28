import { describe, expect, it, vi } from "vitest";

import { SupportedInstrument } from "../../shared/instrument-types.js";
import { InstrumentRegistry } from "./instrument-registry.js";

describe("InstrumentRegistry subscriber lifecycle", () => {
  it("notifies an active runtime for each newly added subscriber without restarting it", async () => {
    const start = vi.fn(async () => undefined);
    const stop = vi.fn(async () => undefined);
    const subscriberAdded = vi.fn(async () => undefined);
    const registry = new InstrumentRegistry({
      dho804: {
        endpoint: { host: "scope.test", port: 5555 },
        runtime: { start: vi.fn(), stop: vi.fn() },
      },
      dm858e: {
        endpoint: { host: "dmm.test", port: 5556 },
        runtime: { start, stop, subscriberAdded },
      },
    });
    const first = {};
    const second = {};

    await registry.subscribe(first, SupportedInstrument.Dm858e);
    await registry.subscribe(second, SupportedInstrument.Dm858e);

    expect(start).toHaveBeenCalledOnce();
    expect(subscriberAdded).toHaveBeenCalledTimes(2);
    expect(stop).not.toHaveBeenCalled();

    await registry.unsubscribe(first, SupportedInstrument.Dm858e);
    expect(stop).not.toHaveBeenCalled();
    await registry.unsubscribe(second, SupportedInstrument.Dm858e);
    expect(stop).toHaveBeenCalledOnce();
  });
});
