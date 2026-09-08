import { describe, expect, it, vi } from "vitest";

import type {
  ScopePowerControl,
  ScopeSleepRuntime,
  ScopeWakeWaiter,
} from "./scope-power-lifecycle.js";
import { ScopePowerLifecycle } from "./scope-power-lifecycle.js";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolver, rejecter) => {
    resolve = resolver;
    reject = rejecter;
  });
  return { promise, resolve, reject };
}

function runtime(): ScopeSleepRuntime & {
  suspendForSleep: ReturnType<typeof vi.fn>;
  resumeAfterSleep: ReturnType<typeof vi.fn>;
} {
  return {
    suspendForSleep: vi.fn(async () => undefined),
    resumeAfterSleep: vi.fn(),
  };
}

function power(): ScopePowerControl & {
  sleep: ReturnType<typeof vi.fn>;
} {
  return {
    sleep: vi.fn(async () => undefined),
  };
}

describe("ScopePowerLifecycle", () => {
  it("suspends the runtime before native Sleep and resumes only after physical wake", async () => {
    const scopeRuntime = runtime();
    const powerControl = power();
    const wake = deferred<boolean>();
    const waitForWake: ScopeWakeWaiter = vi.fn(() => wake.promise);
    const lifecycle = new ScopePowerLifecycle(
      "scope.test",
      5555,
      scopeRuntime,
      powerControl,
      waitForWake,
    );

    await lifecycle.sleep();

    expect(scopeRuntime.suspendForSleep).toHaveBeenCalledOnce();
    expect(powerControl.sleep).toHaveBeenCalledOnce();
    expect(scopeRuntime.suspendForSleep.mock.invocationCallOrder[0]).toBeLessThan(
      powerControl.sleep.mock.invocationCallOrder[0]!,
    );
    expect(waitForWake).toHaveBeenCalledOnce();
    expect(scopeRuntime.resumeAfterSleep).not.toHaveBeenCalled();

    wake.resolve(true);
    await vi.waitFor(() => expect(scopeRuntime.resumeAfterSleep).toHaveBeenCalledOnce());
  });

  it("resumes the runtime when native Sleep fails", async () => {
    const scopeRuntime = runtime();
    const powerControl = power();
    powerControl.sleep.mockRejectedValueOnce(new Error("ADB unavailable"));
    const lifecycle = new ScopePowerLifecycle(
      "scope.test",
      5555,
      scopeRuntime,
      powerControl,
    );

    await expect(lifecycle.sleep()).rejects.toThrow("ADB unavailable");
    expect(scopeRuntime.resumeAfterSleep).toHaveBeenCalledOnce();
  });

  it("cleans up and resumes when the physical-wake monitor fails", async () => {
    const scopeRuntime = runtime();
    const wake = deferred<boolean>();
    const lifecycle = new ScopePowerLifecycle(
      "scope.test",
      5555,
      scopeRuntime,
      power(),
      () => wake.promise,
    );

    await lifecycle.sleep();
    wake.reject(new Error("probe failed"));

    await vi.waitFor(() => expect(scopeRuntime.resumeAfterSleep).toHaveBeenCalledOnce());
  });

  it("rejects a second Sleep request while waiting for physical wake", async () => {
    const scopeRuntime = runtime();
    const wake = deferred<boolean>();
    const lifecycle = new ScopePowerLifecycle(
      "scope.test",
      5555,
      scopeRuntime,
      power(),
      () => wake.promise,
    );

    await lifecycle.sleep();
    await expect(lifecycle.sleep()).rejects.toThrow("already sleeping");

    wake.resolve(true);
    await vi.waitFor(() => expect(scopeRuntime.resumeAfterSleep).toHaveBeenCalledOnce());
  });
});
