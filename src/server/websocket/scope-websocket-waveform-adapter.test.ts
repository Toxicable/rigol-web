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
  WAVEFORM_FRAME_VERSION,
  WAVEFORM_HEADER_BYTES,
  WAVEFORM_MAGIC,
  WaveformEncoding,
} from "../../shared/waveform-protocol.js";
import {
  MessageType,
  WaveformKind,
  type ServerJsonMessage,
} from "../../shared/websocket-protocol.js";
import {
  ScopeConnectionKind,
  type ScopeConnection,
} from "../instruments/instrument-connection.js";
import type { ScopeApplicationService } from "../scope/scope-service.js";
import type { DeepViewportRequest } from "../waveform/deep-capture-service.js";
import { ScopeWebSocketAdapter } from "./scope-websocket-adapter.js";
import type {
  BinarySendCallback,
  WebSocketAdapterHost,
  WebSocketSession,
} from "./websocket-adapter.js";

const info: ScopeInfo = {
  manufacturer: "RIGOL TECHNOLOGIES",
  model: "DHO804",
  serialNumber: "TEST-WAVEFORM",
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

function createWaveformFrame(
  kind: WaveformKind,
  channel: Channel,
  captureId: number,
  sequence: number,
): Uint8Array {
  const frame = new Uint8Array(WAVEFORM_HEADER_BYTES + 8);
  const view = new DataView(frame.buffer);
  view.setUint32(0, WAVEFORM_MAGIC, true);
  view.setUint8(4, WAVEFORM_FRAME_VERSION);
  view.setUint8(5, kind);
  view.setUint8(6, channel);
  view.setUint8(7, WaveformEncoding.IndexedFloat32);
  view.setUint32(8, sequence, true);
  view.setUint32(12, captureId, true);
  view.setUint32(16, 0, true);
  view.setUint32(20, 1, true);
  view.setUint32(24, 1, true);
  view.setUint32(28, WAVEFORM_HEADER_BYTES, true);
  view.setFloat64(32, 1e-9, true);
  view.setFloat64(40, 0, true);
  view.setFloat64(48, 0, true);
  view.setUint8(56, ChannelUnit.Volts);
  view.setUint32(WAVEFORM_HEADER_BYTES, 0, true);
  view.setFloat32(WAVEFORM_HEADER_BYTES + 4, 0.25, true);
  return frame;
}

class FakeHost implements WebSocketAdapterHost {
  public readonly requireSubscribed = vi.fn();
  public readonly sendJson = vi.fn();
  public readonly sendCompleted = vi.fn();
  public readonly sendFailure = vi.fn();
  public readonly broadcastJson = vi.fn();
  public readonly sendBinarySpy = vi.fn();
  public subscribedSession: WebSocketSession | null = null;
  private readonly binaryCallbacks: BinarySendCallback[] = [];

  public isOpen(_session: WebSocketSession): boolean { return true; }
  public isBackpressured(_session: WebSocketSession): boolean { return false; }

  public sendBinary(
    session: WebSocketSession,
    frame: Uint8Array,
    callback?: BinarySendCallback,
  ): void {
    this.sendBinarySpy(session, frame);
    if (callback !== undefined) {
      this.binaryCallbacks.push(callback);
    }
  }

  public completeNextBinary(): void {
    this.binaryCallbacks.shift()?.(undefined);
  }

  public forEachSubscribed(
    instrument: SupportedInstrument,
    callback: (session: WebSocketSession) => void,
  ): void {
    if (
      instrument === SupportedInstrument.Dho804 &&
      this.subscribedSession !== null
    ) {
      callback(this.subscribedSession);
    }
  }
}

interface Harness {
  adapter: ScopeWebSocketAdapter;
  host: FakeHost;
  requestViewport: ReturnType<typeof vi.fn>;
  publishWaveform(frame: Uint8Array): void;
}

function createHarness(): Harness {
  const connection: ScopeConnection = {
    kind: ScopeConnectionKind.Connected,
    info,
    state: createState(),
  };
  let waveformListener: ((frame: Uint8Array) => void) | undefined;
  const requestViewport = vi.fn(async (request: DeepViewportRequest) =>
    createWaveformFrame(
      WaveformKind.DeepViewport,
      request.channel,
      request.captureId,
      77,
    ));
  const service = {
    getConnection: () => connection,
    subscribeConnection: () => () => {},
    subscribeState: () => () => {},
    subscribeWaveform: (listener: (frame: Uint8Array) => void) => {
      waveformListener = listener;
      return () => { waveformListener = undefined; };
    },
    requestViewport,
  } as unknown as ScopeApplicationService;
  const adapter = new ScopeWebSocketAdapter(service);
  const host = new FakeHost();
  adapter.attach(host);
  return {
    adapter,
    host,
    requestViewport,
    publishWaveform: (frame) => waveformListener?.(frame),
  };
}

function sequence(frame: Uint8Array): number {
  return new DataView(
    frame.buffer,
    frame.byteOffset,
    frame.byteLength,
  ).getUint32(8, true);
}

describe("ScopeWebSocketAdapter waveform delivery", () => {
  it("keeps only the latest live frame per channel while a send is in flight", () => {
    const harness = createHarness();
    const session = { id: 1 };
    harness.host.subscribedSession = session;

    harness.publishWaveform(
      createWaveformFrame(WaveformKind.Live, Channel.Ch1, 0, 1),
    );
    harness.publishWaveform(
      createWaveformFrame(WaveformKind.Live, Channel.Ch1, 0, 2),
    );
    harness.publishWaveform(
      createWaveformFrame(WaveformKind.Live, Channel.Ch1, 0, 3),
    );

    expect(harness.host.sendBinarySpy).toHaveBeenCalledTimes(1);
    expect(sequence(harness.host.sendBinarySpy.mock.calls[0]?.[1] as Uint8Array)).toBe(1);

    harness.host.completeNextBinary();
    harness.adapter.transportAvailable(session);

    expect(harness.host.sendBinarySpy).toHaveBeenCalledTimes(2);
    expect(sequence(harness.host.sendBinarySpy.mock.calls[1]?.[1] as Uint8Array)).toBe(3);
    harness.adapter.detach();
  });

  it("maps deep viewport requests through the scope service and sends the frame", async () => {
    const harness = createHarness();
    const session = { id: 2 };

    expect(await harness.adapter.tryDispatch(session, {
      type: MessageType.WaveformViewportRequest,
      requestId: 12,
      captureId: 9,
      channel: Channel.Ch2,
      startSample: 100,
      endSample: 500,
      pixelWidth: 200,
    })).toBe(true);

    expect(harness.host.requireSubscribed).toHaveBeenCalledWith(
      session,
      SupportedInstrument.Dho804,
    );
    expect(harness.requestViewport).toHaveBeenCalledWith({
      captureId: 9,
      channel: Channel.Ch2,
      startSample: 100,
      endSample: 500,
      pixelWidth: 200,
    });
    expect(harness.host.sendBinarySpy).toHaveBeenCalledOnce();
    const frame = harness.host.sendBinarySpy.mock.calls[0]?.[1] as Uint8Array;
    expect(sequence(frame)).toBe(77);
    harness.adapter.detach();
  });

  it("rejects non-live frames on the live publication surface", () => {
    const harness = createHarness();

    expect(() => harness.publishWaveform(
      createWaveformFrame(WaveformKind.DeepViewport, Channel.Ch1, 4, 1),
    )).toThrow("Scope waveform publication only accepts live waveform frames");
    harness.adapter.detach();
  });
});
