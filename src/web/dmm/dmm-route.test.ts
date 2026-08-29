import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";

import {
  DmmAcquisitionRate,
  DmmMeasurementFunction,
  DmmRangeMode,
  DmmReadingKind,
  DmmUnit,
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
  type ScopeWebSocketClient,
} from "../websocket-client.js";
import { DmmRoute, bindDmmRoute, type DmmLifecycleClient } from "./dmm-route.js";
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

  it("renders disconnected transport state without a plausible measurement", () => {
    useDmmStore.getState().setTransportDisconnected("socket lost");
    const client = new FakeDmmLifecycleClient({
      kind: BrowserTransportKind.Disconnected,
      reason: "socket lost",
    });

    const markup = renderToStaticMarkup(createElement(DmmRoute, {
      client: client as unknown as ScopeWebSocketClient,
    }));

    expect(markup).toContain("Transport offline");
    expect(markup).toContain("socket lost");
    expect(markup).not.toContain("Live snapshot");
  });

  it("renders the connected reading and DM858E-targeted console", () => {
    useDmmStore.getState().setConnected(info, dcState);
    useDmmStore.getState().setLatestReading({
      kind: DmmReadingKind.Value,
      function: DmmMeasurementFunction.DcVoltage,
      value: 12.34,
      unit: DmmUnit.Volts,
    });
    const client = new FakeDmmLifecycleClient({ kind: BrowserTransportKind.Connected });

    const markup = renderToStaticMarkup(createElement(DmmRoute, {
      client: client as unknown as ScopeWebSocketClient,
    }));

    expect(markup).toContain("Connected");
    expect(markup).toContain("12.340000");
    expect(markup).toContain("placeholder=\"DATA:LAST?\"");
  });
});
