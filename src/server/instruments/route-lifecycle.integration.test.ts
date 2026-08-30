import { describe, expect, it, vi } from "vitest";

import { SupportedInstrument } from "../../shared/instrument-types.js";
import {
  InstrumentRegistry,
  type InstrumentRuntime,
} from "./instrument-registry.js";

function runtime(): InstrumentRuntime & {
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
} {
  return {
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
  };
}

function registry(
  scopeRuntime = runtime(),
  dmmRuntime = runtime(),
): InstrumentRegistry {
  return new InstrumentRegistry({
    dho804: {
      endpoint: { host: "scope.test", port: 5555 },
      runtime: scopeRuntime,
    },
    dm858e: {
      endpoint: { host: "dmm.test", port: 5556 },
      runtime: dmmRuntime,
    },
  });
}

describe("route-driven instrument lifecycle integration", () => {
  it("switches one browser session between the scope and DMM without leaving the old runtime active", async () => {
    const scopeRuntime = runtime();
    const dmmRuntime = runtime();
    const instruments = registry(scopeRuntime, dmmRuntime);
    const session = {};

    expect(scopeRuntime.start).not.toHaveBeenCalled();
    expect(dmmRuntime.start).not.toHaveBeenCalled();

    await instruments.subscribe(session, SupportedInstrument.Dho804);
    expect(scopeRuntime.start).toHaveBeenCalledOnce();
    expect(dmmRuntime.start).not.toHaveBeenCalled();

    await instruments.unsubscribe(session, SupportedInstrument.Dho804);
    await instruments.subscribe(session, SupportedInstrument.Dm858e);
    expect(scopeRuntime.stop).toHaveBeenCalledOnce();
    expect(dmmRuntime.start).toHaveBeenCalledOnce();
    expect(instruments.isSubscribed(session, SupportedInstrument.Dho804)).toBe(false);
    expect(instruments.isSubscribed(session, SupportedInstrument.Dm858e)).toBe(true);

    await instruments.unsubscribe(session, SupportedInstrument.Dm858e);
    await instruments.subscribe(session, SupportedInstrument.Dho804);
    expect(dmmRuntime.stop).toHaveBeenCalledOnce();
    expect(scopeRuntime.start).toHaveBeenCalledTimes(2);
    expect(instruments.isSubscribed(session, SupportedInstrument.Dho804)).toBe(true);
    expect(instruments.isSubscribed(session, SupportedInstrument.Dm858e)).toBe(false);
  });

  it("keeps a shared runtime active until the last browser session leaves", async () => {
    const scopeRuntime = runtime();
    const instruments = registry(scopeRuntime);
    const firstTab = {};
    const secondTab = {};

    await instruments.subscribe(firstTab, SupportedInstrument.Dho804);
    await instruments.subscribe(secondTab, SupportedInstrument.Dho804);
    expect(scopeRuntime.start).toHaveBeenCalledOnce();

    await instruments.releaseSession(firstTab);
    expect(scopeRuntime.stop).not.toHaveBeenCalled();

    await instruments.releaseSession(secondTab);
    expect(scopeRuntime.stop).toHaveBeenCalledOnce();
  });

  it("keeps the DHO804 and DM858E runtimes independent across two browser tabs", async () => {
    const scopeRuntime = runtime();
    const dmmRuntime = runtime();
    const instruments = registry(scopeRuntime, dmmRuntime);
    const scopeTab = {};
    const dmmTab = {};

    await Promise.all([
      instruments.subscribe(scopeTab, SupportedInstrument.Dho804),
      instruments.subscribe(dmmTab, SupportedInstrument.Dm858e),
    ]);
    expect(scopeRuntime.start).toHaveBeenCalledOnce();
    expect(dmmRuntime.start).toHaveBeenCalledOnce();

    await instruments.releaseSession(scopeTab);
    expect(scopeRuntime.stop).toHaveBeenCalledOnce();
    expect(dmmRuntime.stop).not.toHaveBeenCalled();
    expect(instruments.isSubscribed(dmmTab, SupportedInstrument.Dm858e)).toBe(true);

    await instruments.releaseSession(dmmTab);
    expect(dmmRuntime.stop).toHaveBeenCalledOnce();
  });

  it("converges rapid route switching on the final subscription without a stale DMM runtime", async () => {
    const scopeRuntime = runtime();
    const dmmRuntime = runtime();
    const instruments = registry(scopeRuntime, dmmRuntime);
    const session = {};

    await instruments.subscribe(session, SupportedInstrument.Dho804);

    await Promise.all([
      instruments.unsubscribe(session, SupportedInstrument.Dho804),
      instruments.subscribe(session, SupportedInstrument.Dm858e),
      instruments.unsubscribe(session, SupportedInstrument.Dm858e),
      instruments.subscribe(session, SupportedInstrument.Dho804),
    ]);

    expect(instruments.isSubscribed(session, SupportedInstrument.Dho804)).toBe(true);
    expect(instruments.isSubscribed(session, SupportedInstrument.Dm858e)).toBe(false);
    expect(scopeRuntime.start).toHaveBeenCalledOnce();
    expect(scopeRuntime.stop).not.toHaveBeenCalled();
    expect(dmmRuntime.stop.mock.calls.length).toBe(dmmRuntime.start.mock.calls.length);
  });
});
