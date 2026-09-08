import { describe, expect, it, vi } from "vitest";

import { SupportedInstrument } from "../../shared/instrument-types.js";
import {
  AcquisitionType,
  Channel,
  ChannelCoupling,
  ChannelUnit,
  EdgeSlope,
  ScopeRunState,
  TimebaseMode,
  TriggerCoupling,
  TriggerSweep,
  TriggerType,
  type ScopeInfo,
  type ScopeState,
} from "../../shared/scope-types.js";
import {
  ControlKind,
  MessageType,
  type ServerJsonMessage,
} from "../../shared/websocket-protocol.js";
import {
  ScopeConnectionKind,
  type ScopeConnection,
} from "../instruments/instrument-connection.js";
import type { ScopeApplicationService } from "../scope/scope-service.js";
import { ScopeWebSocketAdapter } from "./scope-websocket-adapter.js";
import type {
  BinarySendCallback,
  WebSocketAdapterHost,
  WebSocketSession,
} from "./websocket-adapter.js";

const info: ScopeInfo = {
  manufacturer: "RIGOL TECHNOLOGIES",
  model: "DHO804",
  serialNumber: "TEST-ADAPTER",
  softwareVersion: "00.01.00",
};

function createState(): ScopeState {
  return {
    channels: [Channel.Ch1, Channel.Ch2, Channel.Ch3, Channel.Ch4].map((channel) => ({
      channel,
      enabled: channel === Channel.Ch1,
      coupling: ChannelCoupling.Dc,
      unit: ChannelUnit.Volts,
      scale: 1,
      offset: 0,
      probeRatio: 1,
    })) as ScopeState["channels"],
    horizontal: { mode: TimebaseMode.Main, scale: 1e-3, position: 0 },
    acquisition: {
      type: AcquisitionType.Normal,
      averages: 2,
      memoryDepth: 1_000,
      sampleRate: 1_000_000,
    },
    runState: ScopeRunState.Running,
    trigger: {
      type: TriggerType.Edge,
      sweep: TriggerSweep.Auto,
      source: Channel.Ch1,
      slope: EdgeSlope.Rising,
      level: 0,
      coupling: TriggerCoupling.Dc,
    },
  };
}

class FakeHost implements WebSocketAdapterHost {
  public readonly requireSubscribed = vi.fn();
  public readonly sendJson = vi.fn();
  public readonly sendCompleted = vi.fn();
  public readonly sendFailure = vi.fn();
  public readonly broadcastJson = vi.fn();

  public isOpen(_session: WebSocketSession): boolean { return true; }
  public isBackpressured(_session: WebSocketSession): boolean { return false; }
  public sendBinary(
    _session: WebSocketSession,
    _frame: Uint8Array,
    callback?: BinarySendCallback,
  ): void {
    callback?.(undefined);
  }
  public forEachSubscribed(
    _instrument: SupportedInstrument,
    _callback: (session: WebSocketSession) => void,
  ): void {}
}

interface Harness {
  adapter: ScopeWebSocketAdapter;
  host: FakeHost;
  service: ScopeApplicationService;
  setControl: ReturnType<typeof vi.fn>;
  publishState(state: ScopeState): void;
}

function createHarness(): Harness {
  const connection: ScopeConnection = {
    kind: ScopeConnectionKind.Connected,
    info,
    state: createState(),
  };
  let stateListener: ((state: ScopeState) => void) | undefined;
  const setControl = vi.fn(async () => undefined);
  const service = {
    getConnection: () => connection,
    subscribeConnection: () => () => {},
    subscribeState: (listener: (state: ScopeState) => void) => {
      stateListener = listener;
      return () => { stateListener = undefined; };
    },
    subscribeWaveform: () => () => {},
    setControl,
    pauseLiveWaveform: vi.fn(async () => undefined),
    resumeLiveWaveform: vi.fn(),
  } as unknown as ScopeApplicationService;
  const adapter = new ScopeWebSocketAdapter(service);
  const host = new FakeHost();
  adapter.attach(host);
  return {
    adapter,
    host,
    service,
    setControl,
    publishState: (state) => stateListener?.(state),
  };
}

describe("ScopeWebSocketAdapter", () => {
  it("validates and dispatches scope controls without a real socket", async () => {
    const harness = createHarness();
    const session = { id: 1 };

    expect(await harness.adapter.tryDispatch(session, {
      type: MessageType.ControlSet,
      requestId: 7,
      control: {
        kind: ControlKind.ChannelEnabled,
        channel: Channel.Ch2,
        value: true,
      },
    })).toBe(true);

    expect(harness.host.requireSubscribed).toHaveBeenCalledWith(
      session,
      SupportedInstrument.Dho804,
    );
    expect(harness.setControl).toHaveBeenCalledWith({
      kind: ControlKind.ChannelEnabled,
      channel: Channel.Ch2,
      value: true,
    });
    expect(harness.host.sendCompleted).toHaveBeenCalledWith(session, 7);
    harness.adapter.detach();
  });

  it("projects scope state publications through the adapter host", () => {
    const harness = createHarness();
    const state = { ...createState(), runState: ScopeRunState.Stopped };

    harness.publishState(state);

    expect(harness.host.broadcastJson).toHaveBeenCalledWith(
      SupportedInstrument.Dho804,
      { type: MessageType.ScopeState, state } satisfies ServerJsonMessage,
    );
    harness.adapter.detach();
  });

  it("does not claim raw SCPI targeted at the DMM", async () => {
    const harness = createHarness();

    expect(await harness.adapter.tryDispatch({ id: 2 }, {
      type: MessageType.ScpiExecute,
      requestId: 8,
      instrument: SupportedInstrument.Dm858e,
      command: "*IDN?",
    })).toBe(false);
    expect(harness.host.requireSubscribed).not.toHaveBeenCalled();
    harness.adapter.detach();
  });
});
