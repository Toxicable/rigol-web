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

describe("InstrumentRegistry", () => {
  it("starts on the first subscriber and stops on the last", async () => {
    const scopeRuntime = runtime();
    const instruments = registry(scopeRuntime);
    const first = {};
    const second = {};

    await instruments.subscribe(first, SupportedInstrument.Dho804);
    await instruments.subscribe(second, SupportedInstrument.Dho804);
    expect(scopeRuntime.start).toHaveBeenCalledOnce();

    await instruments.unsubscribe(first, SupportedInstrument.Dho804);
    expect(scopeRuntime.stop).not.toHaveBeenCalled();

    await instruments.unsubscribe(second, SupportedInstrument.Dho804);
    expect(scopeRuntime.stop).toHaveBeenCalledOnce();
  });

  it("suspends a running instrument without dropping subscribers and resumes it", async () => {
    const scopeRuntime = runtime();
    const instruments = registry(scopeRuntime);
    const session = {};

    await instruments.subscribe(session, SupportedInstrument.Dho804);
    await instruments.suspend(SupportedInstrument.Dho804);

    expect(scopeRuntime.stop).toHaveBeenCalledOnce();
    expect(instruments.isSubscribed(session, SupportedInstrument.Dho804)).toBe(true);

    await instruments.resume(SupportedInstrument.Dho804);

    expect(scopeRuntime.start).toHaveBeenCalledTimes(2);
    expect(instruments.isSubscribed(session, SupportedInstrument.Dho804)).toBe(true);
  });

  it("does not start a newly subscribed instrument until suspension is lifted", async () => {
    const scopeRuntime = runtime();
    const instruments = registry(scopeRuntime);
    const session = {};

    await instruments.suspend(SupportedInstrument.Dho804);
    await instruments.subscribe(session, SupportedInstrument.Dho804);

    expect(scopeRuntime.start).not.toHaveBeenCalled();

    await instruments.resume(SupportedInstrument.Dho804);

    expect(scopeRuntime.start).toHaveBeenCalledOnce();
  });

  it("rolls back a subscriber when activation fails and allows retry", async () => {
    const scopeRuntime = runtime();
    scopeRuntime.start
      .mockRejectedValueOnce(new Error("scope unavailable"))
      .mockResolvedValueOnce(undefined);
    const instruments = registry(scopeRuntime);
    const session = {};

    await expect(
      instruments.subscribe(session, SupportedInstrument.Dho804),
    ).rejects.toThrow("scope unavailable");
    expect(instruments.isSubscribed(session, SupportedInstrument.Dho804)).toBe(false);

    await instruments.subscribe(session, SupportedInstrument.Dho804);

    expect(scopeRuntime.start).toHaveBeenCalledTimes(2);
    expect(instruments.isSubscribed(session, SupportedInstrument.Dho804)).toBe(true);
  });

  it("allows reactivation after deactivation fails", async () => {
    const scopeRuntime = runtime();
    scopeRuntime.stop.mockRejectedValueOnce(new Error("cleanup failed"));
    const instruments = registry(scopeRuntime);
    const session = {};

    await instruments.subscribe(session, SupportedInstrument.Dho804);
    await expect(
      instruments.unsubscribe(session, SupportedInstrument.Dho804),
    ).rejects.toThrow("cleanup failed");
    expect(instruments.isSubscribed(session, SupportedInstrument.Dho804)).toBe(false);

    await instruments.subscribe(session, SupportedInstrument.Dho804);

    expect(scopeRuntime.start).toHaveBeenCalledTimes(2);
    expect(instruments.isSubscribed(session, SupportedInstrument.Dho804)).toBe(true);
  });

  it("releases all subscriptions owned by a disconnected browser session", async () => {
    const scopeRuntime = runtime();
    const dmmRuntime = runtime();
    const instruments = registry(scopeRuntime, dmmRuntime);
    const session = {};

    await instruments.subscribe(session, SupportedInstrument.Dho804);
    await instruments.subscribe(session, SupportedInstrument.Dm858e);
    await instruments.releaseSession(session);

    expect(scopeRuntime.stop).toHaveBeenCalledOnce();
    expect(dmmRuntime.stop).toHaveBeenCalledOnce();
    expect(instruments.isSubscribed(session, SupportedInstrument.Dho804)).toBe(false);
    expect(instruments.isSubscribed(session, SupportedInstrument.Dm858e)).toBe(false);
  });

  it("activates different instruments independently", async () => {
    const scopeRuntime = runtime();
    const dmmRuntime = runtime();
    const instruments = registry(scopeRuntime, dmmRuntime);
    const scopeSession = {};
    const dmmSession = {};

    await instruments.subscribe(scopeSession, SupportedInstrument.Dho804);
    expect(scopeRuntime.start).toHaveBeenCalledOnce();
    expect(dmmRuntime.start).not.toHaveBeenCalled();

    await instruments.subscribe(dmmSession, SupportedInstrument.Dm858e);
    expect(dmmRuntime.start).toHaveBeenCalledOnce();

    await instruments.unsubscribe(scopeSession, SupportedInstrument.Dho804);
    expect(scopeRuntime.stop).toHaveBeenCalledOnce();
    expect(dmmRuntime.stop).not.toHaveBeenCalled();
  });

  it("reconciles a re-subscribe that arrives during a delayed stop", async () => {
    let finishStop!: () => void;
    const stopGate = new Promise<void>((resolve) => {
      finishStop = resolve;
    });
    const scopeRuntime = runtime();
    scopeRuntime.stop.mockImplementationOnce(() => stopGate);
    const instruments = registry(scopeRuntime);
    const first = {};
    const second = {};

    await instruments.subscribe(first, SupportedInstrument.Dho804);
    const stopping = instruments.unsubscribe(first, SupportedInstrument.Dho804);
    await vi.waitFor(() => expect(scopeRuntime.stop).toHaveBeenCalledOnce());
    const restarting = instruments.subscribe(second, SupportedInstrument.Dho804);

    finishStop();
    await Promise.all([stopping, restarting]);

    expect(scopeRuntime.start).toHaveBeenCalledTimes(2);
    expect(instruments.isSubscribed(second, SupportedInstrument.Dho804)).toBe(true);
  });

  it("stops after an unsubscribe that arrives during a delayed start", async () => {
    let finishStart!: () => void;
    const startGate = new Promise<void>((resolve) => {
      finishStart = resolve;
    });
    const scopeRuntime = runtime();
    scopeRuntime.start.mockImplementationOnce(() => startGate);
    const instruments = registry(scopeRuntime);
    const session = {};

    const starting = instruments.subscribe(session, SupportedInstrument.Dho804);
    await vi.waitFor(() => expect(scopeRuntime.start).toHaveBeenCalledOnce());
    const stopping = instruments.unsubscribe(session, SupportedInstrument.Dho804);

    finishStart();
    await Promise.all([starting, stopping]);

    expect(scopeRuntime.stop).toHaveBeenCalledOnce();
    expect(instruments.isSubscribed(session, SupportedInstrument.Dho804)).toBe(false);
  });
});
