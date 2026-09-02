import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";

import {
  DmmAcquisitionRate,
  DmmControlKind,
  DmmMeasurementFunction,
  DmmRangeMode,
  DmmReadingKind,
  DmmUnit,
  type DmmControlChange,
  type DmmInfo,
  type DmmState,
} from "../../shared/dmm-types.js";
import { SupportedInstrument } from "../../shared/instrument-types.js";
import {
  MessageType,
  PROTOCOL_VERSION,
  type DmmLifecycleMessage,
} from "../../shared/websocket-protocol.js";
import {
  BrowserTransportKind,
  type BrowserTransportState,
} from "../websocket-client.js";
import {
  bindDmmRoute,
  type DmmLifecycleClient,
} from "./dmm-route-binding.js";
import {
  DmmRouteView,
  applyDmmControl,
  type DmmControlClient,
} from "./dmm-route.js";
import { DmmBrowserConnectionKind, useDmmStore } from "./dmm-store.js";

const info: DmmInfo = {
  manufacturer: "RIGOL TECHNOLOGIES",
  model: "DM858E",
  serialNumber: "DM8A000000000",
  firmwareVersion: "00.01",
};

const dcState: DmmState = {
  function: DmmMeasurementFunction.DcVoltage,
  range: { mode: DmmRangeMode.Auto },
  acquisitionRate: DmmAcquisitionRate.Slow,
};

class FakeDmmLifecycleClient implements DmmLifecycleClient {
  public readonly subscriptions: SupportedInstrument[] = [];
  public readonly unsubscriptions: SupportedInstrument[] = [];
  private transportListener: ((state: BrowserTransportState) => void) | null = null;
  private dmmListener: ((message: DmmLifecycleMessage) => void) | null = null;

  public constructor(private transportState: BrowserTransportState) {}

  public onTransportState(listener: (state: BrowserTransportState) => void): () => void {
    this.transportListener = listener;
    listener(this.transportState);
    return () => {
      if (this.transportListener === listener) {
        this.transportListener = null;
      }
    };
  }

  public onDmmMessage(listener: (message: DmmLifecycleMessage) => void): () => void {
    this.dmmListener = listener;
    return () => {
      if (this.dmmListener === listener) {
        this.dmmListener = null;
      }
    };
  }

  public subscribeInstrument(instrument: SupportedInstrument): void {
    this.subscriptions.push(instrument);
  }

  public unsubscribeInstrument(instrument: SupportedInstrument): void {
    this.unsubscriptions.push(instrument);
  }

  public emitTransport(state: BrowserTransportState): void {
    this.transportState = state;
    this.transportListener?.(state);
  }

  public emitDmm(message: DmmLifecycleMessage): void {
    this.dmmListener?.(message);
  }
}

interface Deferred {
  readonly promise: Promise<void>;
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

function queuedControlClient(...operations: Deferred[]): {
  readonly client: DmmControlClient;
  readonly sent: DmmControlChange[];
} {
  const sent: DmmControlChange[] = [];
  let next = 0;
  return {
    sent,
    client: {
      setDmmControl: (control) => {
        sent.push(control);
        const operation = operations[next];
        next += 1;
        if (operation === undefined) {
          throw new Error("Missing deferred control operation");
        }
        return operation.promise;
      },
    },
  };
}

beforeEach(() => {
  useDmmStore.getState().setConnecting();
});

describe("DM858E route lifecycle", () => {
  it("subscribes on mount and unsubscribes on cleanup", () => {
    const client = new FakeDmmLifecycleClient({ kind: BrowserTransportKind.Connected });
    const cleanup = bindDmmRoute(client);

    expect(client.subscriptions).toEqual([SupportedInstrument.Dm858e]);
    expect(useDmmStore.getState().connection.kind).toBe(
      DmmBrowserConnectionKind.AwaitingInstrument,
    );

    cleanup();

    expect(client.unsubscriptions).toEqual([SupportedInstrument.Dm858e]);
  });

  it("tracks authoritative lifecycle, state and current-function snapshots", () => {
    const client = new FakeDmmLifecycleClient({ kind: BrowserTransportKind.Connected });
    bindDmmRoute(client);

    client.emitDmm({
      type: MessageType.DmmConnected,
      protocolVersion: PROTOCOL_VERSION,
      info,
      state: dcState,
    });
    client.emitDmm({
      type: MessageType.DmmSnapshot,
      snapshot: {
        kind: DmmReadingKind.Value,
        function: DmmMeasurementFunction.DcVoltage,
        value: 12.34,
        resolution: 0.001,
        unit: DmmUnit.Volts,
      },
    });
    expect(useDmmStore.getState().latestReading?.function).toBe(
      DmmMeasurementFunction.DcVoltage,
    );

    const acState: DmmState = {
      function: DmmMeasurementFunction.AcVoltage,
      range: { mode: DmmRangeMode.Auto },
      acquisitionRate: DmmAcquisitionRate.Medium,
    };
    client.emitDmm({ type: MessageType.DmmState, state: acState });
    expect(useDmmStore.getState().latestReading).toBeNull();

    client.emitDmm({
      type: MessageType.DmmSnapshot,
      snapshot: {
        kind: DmmReadingKind.Value,
        function: DmmMeasurementFunction.DcVoltage,
        value: 9.9,
        resolution: 0.001,
        unit: DmmUnit.Volts,
      },
    });
    expect(useDmmStore.getState().latestReading).toBeNull();
  });

  it("clears display state on transport and instrument disconnects", () => {
    const client = new FakeDmmLifecycleClient({ kind: BrowserTransportKind.Connected });
    bindDmmRoute(client);
    client.emitDmm({
      type: MessageType.DmmConnected,
      protocolVersion: PROTOCOL_VERSION,
      info,
      state: dcState,
    });
    client.emitDmm({
      type: MessageType.DmmSnapshot,
      snapshot: {
        kind: DmmReadingKind.Value,
        function: DmmMeasurementFunction.DcVoltage,
        value: 1,
        resolution: 0.001,
        unit: DmmUnit.Volts,
      },
    });

    client.emitDmm({ type: MessageType.DmmDisconnected, reason: "meter rebooted" });
    expect(useDmmStore.getState().connection).toEqual({
      kind: DmmBrowserConnectionKind.InstrumentDisconnected,
      reason: "meter rebooted",
    });
    expect(useDmmStore.getState().latestReading).toBeNull();

    client.emitTransport({
      kind: BrowserTransportKind.Disconnected,
      reason: "socket lost",
    });
    expect(useDmmStore.getState().connection).toEqual({
      kind: DmmBrowserConnectionKind.TransportDisconnected,
      reason: "socket lost",
    });
  });

  it("ignores an old-session rejection after a new session control begins", async () => {
    const first = deferred();
    const second = deferred();
    const { client } = queuedControlClient(first, second);
    useDmmStore.getState().setConnected(info, dcState);

    const oldRequest = applyDmmControl(client, {
      kind: DmmControlKind.Range,
      function: DmmMeasurementFunction.DcVoltage,
      value: { mode: DmmRangeMode.Fixed, value: 10 },
    });

    useDmmStore.getState().setConnected(info, dcState);
    const newRequest = applyDmmControl(client, {
      kind: DmmControlKind.AcquisitionRate,
      function: DmmMeasurementFunction.DcVoltage,
      value: DmmAcquisitionRate.Fast,
    });

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

  it("ignores an old-route completion after unmount and remount", async () => {
    const first = deferred();
    const second = deferred();
    const { client } = queuedControlClient(first, second);
    useDmmStore.getState().setConnected(info, dcState);

    const oldRequest = applyDmmControl(client, {
      kind: DmmControlKind.Range,
      function: DmmMeasurementFunction.DcVoltage,
      value: { mode: DmmRangeMode.Fixed, value: 10 },
    });

    useDmmStore.getState().setAwaitingInstrument();
    useDmmStore.getState().setConnected(info, dcState);
    const newRequest = applyDmmControl(client, {
      kind: DmmControlKind.AcquisitionRate,
      function: DmmMeasurementFunction.DcVoltage,
      value: DmmAcquisitionRate.Fast,
    });

    first.resolve();
    await oldRequest;
    expect(useDmmStore.getState().pendingControl?.control).toEqual({
      kind: DmmControlKind.AcquisitionRate,
      function: DmmMeasurementFunction.DcVoltage,
      value: DmmAcquisitionRate.Fast,
    });

    second.resolve();
    await newRequest;
  });

  it("does not send a control that already matches authoritative state", async () => {
    const operation = deferred();
    const { client, sent } = queuedControlClient(operation);
    useDmmStore.getState().setConnected(info, dcState);

    await applyDmmControl(client, {
      kind: DmmControlKind.Function,
      value: DmmMeasurementFunction.DcVoltage,
    });

    expect(sent).toEqual([]);
    expect(useDmmStore.getState().pendingControl).toBeNull();
  });

  it("renders disconnected transport state without a plausible measurement", () => {
    const markup = renderToStaticMarkup(createElement(DmmRouteView, {
      connection: {
        kind: DmmBrowserConnectionKind.TransportDisconnected,
        reason: "socket lost",
      },
      latestReading: null,
      pending: false,
      controlError: null,
      onControl: () => undefined,
    }));

    expect(markup).toContain("Transport offline");
    expect(markup).toContain("socket lost");
    expect(markup).not.toContain("Latest reading");
  });

  it("renders the connected reading and browser snapshot trend", () => {
    const markup = renderToStaticMarkup(createElement(DmmRouteView, {
      connection: {
        kind: DmmBrowserConnectionKind.Connected,
        info,
        state: dcState,
      },
      latestReading: {
        kind: DmmReadingKind.Value,
        function: DmmMeasurementFunction.DcVoltage,
        value: 12.34,
        resolution: 0.001,
        unit: DmmUnit.Volts,
      },
      pending: false,
      controlError: null,
      onControl: () => undefined,
    }));

    expect(markup).toContain("Connected");
    expect(markup).toContain("Latest reading");
    expect(markup).toContain(">12.34<");
    expect(markup).not.toContain("12.3400");
    expect(markup).toContain("Snapshot trend");
    expect(markup).toContain("visual trend");
  });
});
