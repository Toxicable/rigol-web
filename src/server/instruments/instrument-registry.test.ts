import { describe, expect, it, vi } from "vitest";

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
  ppk2Runtime = runtime(),
): InstrumentRegistry {
  return new InstrumentRegistry({
    dho804: scopeRuntime,
    dm858e: dmmRuntime,
    ppk2: ppk2Runtime,
  });
}

describe("InstrumentRegistry", () => {
  it("starts all known runtimes once and keeps startAll idempotent", async () => {
    const scopeRuntime = runtime();
    const dmmRuntime = runtime();
    const ppk2Runtime = runtime();
    const instruments = registry(scopeRuntime, dmmRuntime, ppk2Runtime);

    await instruments.startAll();
    await instruments.startAll();

    expect(scopeRuntime.start).toHaveBeenCalledOnce();
    expect(dmmRuntime.start).toHaveBeenCalledOnce();
    expect(ppk2Runtime.start).toHaveBeenCalledOnce();
    expect(scopeRuntime.stop).not.toHaveBeenCalled();
    expect(dmmRuntime.stop).not.toHaveBeenCalled();
    expect(ppk2Runtime.stop).not.toHaveBeenCalled();
  });

  it("stops all server-owned runtimes once and keeps stopAll idempotent", async () => {
    const scopeRuntime = runtime();
    const dmmRuntime = runtime();
    const ppk2Runtime = runtime();
    const instruments = registry(scopeRuntime, dmmRuntime, ppk2Runtime);
    await instruments.startAll();

    await instruments.stopAll();
    await instruments.stopAll();

    expect(scopeRuntime.stop).toHaveBeenCalledOnce();
    expect(dmmRuntime.stop).toHaveBeenCalledOnce();
    expect(ppk2Runtime.stop).toHaveBeenCalledOnce();
  });

  it("retries only a runtime whose start failed", async () => {
    const scopeRuntime = runtime();
    const dmmRuntime = runtime();
    const ppk2Runtime = runtime();
    scopeRuntime.start
      .mockRejectedValueOnce(new Error("scope start failed"))
      .mockResolvedValueOnce(undefined);
    const instruments = registry(scopeRuntime, dmmRuntime, ppk2Runtime);

    await expect(instruments.startAll()).rejects.toThrow("scope start failed");
    await instruments.startAll();

    expect(scopeRuntime.start).toHaveBeenCalledTimes(2);
    expect(dmmRuntime.start).toHaveBeenCalledOnce();
    expect(ppk2Runtime.start).toHaveBeenCalledOnce();
  });

  it("stops every runtime even when one stop fails and allows that stop to retry", async () => {
    const scopeRuntime = runtime();
    const dmmRuntime = runtime();
    const ppk2Runtime = runtime();
    scopeRuntime.stop
      .mockRejectedValueOnce(new Error("scope stop failed"))
      .mockResolvedValueOnce(undefined);
    const instruments = registry(scopeRuntime, dmmRuntime, ppk2Runtime);
    await instruments.startAll();

    await expect(instruments.stopAll()).rejects.toThrow("scope stop failed");
    expect(dmmRuntime.stop).toHaveBeenCalledOnce();
    expect(ppk2Runtime.stop).toHaveBeenCalledOnce();

    await instruments.stopAll();

    expect(scopeRuntime.stop).toHaveBeenCalledTimes(2);
    expect(dmmRuntime.stop).toHaveBeenCalledOnce();
    expect(ppk2Runtime.stop).toHaveBeenCalledOnce();
  });

  it("serializes shutdown behind an in-flight startup", async () => {
    let finishStart!: () => void;
    const startGate = new Promise<void>((resolve) => {
      finishStart = resolve;
    });
    const scopeRuntime = runtime();
    scopeRuntime.start.mockImplementationOnce(() => startGate);
    const dmmRuntime = runtime();
    const ppk2Runtime = runtime();
    const instruments = registry(scopeRuntime, dmmRuntime, ppk2Runtime);

    const starting = instruments.startAll();
    await vi.waitFor(() => expect(scopeRuntime.start).toHaveBeenCalledOnce());
    const stopping = instruments.stopAll();

    expect(scopeRuntime.stop).not.toHaveBeenCalled();
    finishStart();
    await Promise.all([starting, stopping]);

    expect(scopeRuntime.stop).toHaveBeenCalledOnce();
    expect(dmmRuntime.stop).toHaveBeenCalledOnce();
    expect(ppk2Runtime.stop).toHaveBeenCalledOnce();
  });
});
