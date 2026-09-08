import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  DmmAcquisitionRate,
  DmmControlKind,
  DmmMeasurementFunction,
  DmmRangeMode,
  type DmmControlChange,
  type DmmInfo,
  type DmmState,
} from "../../shared/dmm-types.js";
import { DmmActions, type DmmActionBinding } from "./dmm-actions.js";
import { useDmmStore } from "./dmm-store.js";

const INFO: DmmInfo = {
  manufacturer: "RIGOL TECHNOLOGIES",
  model: "DM858E",
  serialNumber: "DM8A000000000",
  firmwareVersion: "00.01",
};

const DC_STATE: DmmState = {
  function: DmmMeasurementFunction.DcVoltage,
  range: { mode: DmmRangeMode.Auto },
  acquisitionRate: DmmAcquisitionRate.Slow,
};

interface Deferred {
  promise: Promise<void>;
  resolve(): void;
  reject(error: Error): void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function queuedBinding(...operations: Deferred[]): {
  binding: DmmActionBinding;
  sent: DmmControlChange[];
} {
  const sent: DmmControlChange[] = [];
  let next = 0;
  return {
    sent,
    binding: {
      setDmmControl: vi.fn((control) => {
        sent.push(control);
        const operation = operations[next];
        next += 1;
        return operation?.promise ?? Promise.resolve();
      }),
    },
  };
}

beforeEach(() => {
  useDmmStore.getState().setConnected(INFO, DC_STATE);
});

describe("DmmActions", () => {
  it("constructs range and rate controls from authoritative DMM state", async () => {
    const { binding, sent } = queuedBinding();
    const actions = new DmmActions(binding);

    await actions.setRange({ mode: DmmRangeMode.Fixed, value: 10 });
    await actions.setAcquisitionRate(DmmAcquisitionRate.Fast);

    expect(sent).toEqual([
      {
        kind: DmmControlKind.Range,
        function: DmmMeasurementFunction.DcVoltage,
        value: { mode: DmmRangeMode.Fixed, value: 10 },
      },
      {
        kind: DmmControlKind.AcquisitionRate,
        function: DmmMeasurementFunction.DcVoltage,
        value: DmmAcquisitionRate.Fast,
      },
    ]);
    expect(useDmmStore.getState().pendingControl).toBeNull();
  });

  it("does not send a control that already matches authoritative state", async () => {
    const { binding, sent } = queuedBinding();
    const actions = new DmmActions(binding);

    await actions.setFunction(DmmMeasurementFunction.DcVoltage);
    await actions.setRange({ mode: DmmRangeMode.Auto });
    await actions.setAcquisitionRate(DmmAcquisitionRate.Slow);

    expect(sent).toEqual([]);
  });

  it("owns DMM pending and failure presentation", async () => {
    const operation = deferred();
    const { binding } = queuedBinding(operation);
    const actions = new DmmActions(binding);

    const request = actions.setAcquisitionRate(DmmAcquisitionRate.Fast);
    expect(useDmmStore.getState().pendingControl?.control).toEqual({
      kind: DmmControlKind.AcquisitionRate,
      function: DmmMeasurementFunction.DcVoltage,
      value: DmmAcquisitionRate.Fast,
    });

    operation.reject(new Error("DMM control rejected"));
    await request;

    expect(useDmmStore.getState().pendingControl).toBeNull();
    expect(useDmmStore.getState().controlError).toBe("DMM control rejected");
  });

  it("ignores an old-session rejection after a newer session control begins", async () => {
    const first = deferred();
    const second = deferred();
    const { binding } = queuedBinding(first, second);
    const actions = new DmmActions(binding);

    const oldRequest = actions.setRange({ mode: DmmRangeMode.Fixed, value: 10 });

    useDmmStore.getState().setConnected(INFO, DC_STATE);
    const newRequest = actions.setAcquisitionRate(DmmAcquisitionRate.Fast);

    first.reject(new Error("old session failed"));
    await oldRequest;

    expect(useDmmStore.getState().pendingControl?.control).toEqual({
      kind: DmmControlKind.AcquisitionRate,
      function: DmmMeasurementFunction.DcVoltage,
      value: DmmAcquisitionRate.Fast,
    });
    expect(useDmmStore.getState().controlError).toBeNull();

    second.resolve();
    await newRequest;
    expect(useDmmStore.getState().pendingControl).toBeNull();
  });
});
