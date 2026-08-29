import { describe, expect, it } from "vitest";

import {
  DmmAcquisitionRate,
  DmmControlKind,
  DmmMeasurementFunction,
  DmmRangeMode,
  type DmmState,
} from "../../shared/dmm-types.js";
import { DmmRuntime } from "./dmm-runtime.js";
import { DmmStateStore } from "./dmm-state-store.js";

interface Deferred {
  promise: Promise<void>;
  resolve(): void;
}

interface RuntimeInternals {
  session: unknown;
}

const state: DmmState = {
  function: DmmMeasurementFunction.DcVoltage,
  range: { mode: DmmRangeMode.Auto },
  acquisitionRate: DmmAcquisitionRate.Slow,
};

class MutationDriver {
  public readonly calls: string[] = [];

  public constructor(
    private readonly blockFunctionWrite: Deferred | null = null,
    private readonly functionEntered: Deferred | null = null,
  ) {}

  public async setFunction(value: DmmMeasurementFunction): Promise<void> {
    this.calls.push(`function:${value}`);
    this.functionEntered?.resolve();
    await this.blockFunctionWrite?.promise;
  }

  public async readDmmState(): Promise<DmmState> {
    this.calls.push("state");
    return state;
  }

  public async executeRawScpi(command: string): Promise<string> {
    this.calls.push(`raw:${command}`);
    return "";
  }
}

function createDeferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

function sessionFor(driver: MutationDriver): object {
  return {
    driver,
    stateStore: new DmmStateStore(state),
    transport: { isUsable: () => true },
    failure: { fail: () => {} },
  };
}

describe("DmmRuntime mutation session ownership", () => {
  it("rejects queued control and raw-SCPI work instead of replaying it on a replacement session", async () => {
    const blocker = createDeferred();
    const entered = createDeferred();
    const firstDriver = new MutationDriver(blocker, entered);
    const secondDriver = new MutationDriver();
    const runtime = new DmmRuntime({
      host: "dmm.test",
      port: 5556,
      publishConnection: () => {},
      publishState: () => {},
      publishSnapshot: () => {},
    });
    const internals = runtime as unknown as RuntimeInternals;
    internals.session = sessionFor(firstDriver);

    const activeMutation = runtime.setControl({
      kind: DmmControlKind.Function,
      value: DmmMeasurementFunction.Resistance2Wire,
    });
    await entered.promise;

    const queuedControl = runtime.setControl({
      kind: DmmControlKind.Function,
      value: DmmMeasurementFunction.AcVoltage,
    });
    const queuedRawScpi = runtime.executeRawScpi("*CLS");

    internals.session = sessionFor(secondDriver);
    blocker.resolve();

    await expect(activeMutation).rejects.toThrow(/DMM session changed/);
    await expect(queuedControl).rejects.toThrow(/DMM session changed/);
    await expect(queuedRawScpi).rejects.toThrow(/DMM session changed/);

    expect(firstDriver.calls).toEqual([
      `function:${DmmMeasurementFunction.Resistance2Wire}`,
    ]);
    expect(secondDriver.calls).toEqual([]);
  });
});
