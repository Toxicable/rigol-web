import { once } from "node:events";
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket, type RawData } from "ws";

import type { DmmControlChange, DmmReadingSnapshot, DmmState } from "../../shared/dmm-types.js";
import { SupportedInstrument } from "../../shared/instrument-types.js";
import {
  AcquisitionType,
  Channel,
  ChannelCoupling,
  ChannelUnit,
  EdgeSlope,
  MeasurementKind,
  ScopeRunState,
  TimebaseMode,
  TriggerCoupling,
  TriggerSweep,
  TriggerType,
  type MeasurementSpec,
  type MeasurementValue,
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
  AcquisitionAction,
  ControlKind,
  MessageType,
  PROTOCOL_VERSION,
  WaveformKind,
  type ControlChange,
  type InteractiveControl,
  type NonEmptyArray,
  type ServerJsonMessage,
} from "../../shared/websocket-protocol.js";
import type { DmmApplicationService } from "../dmm/dmm-service.js";
import {
  DmmConnectionKind,
  ScopeConnectionKind,
  type DmmConnection,
  type ScopeConnection,
} from "../instruments/instrument-connection.js";
import { InstrumentRegistry } from "../instruments/instrument-registry.js";
import type { ScopeApplicationService } from "../scope/scope-service.js";
import type { DeepCaptureInfo, DeepViewportRequest } from "../waveform/deep-capture-service.js";
import { WebSocketGateway } from "./websocket-gateway.js";

const scopeInfo: ScopeInfo = {
  manufacturer: "RIGOL TECHNOLOGIES",
  model: "DHO804",
  serialNumber: "TEST0001",
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
      memoryDepth: 1_000_000,
      sampleRate: 100_000_000,
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

function measurementValue(spec: MeasurementSpec, current: number): MeasurementValue {
  return {
    ...spec,
    statistics: {
      current,
      minimum: current - 0.1,
      maximum: current + 0.1,
      average: current,
      deviation: 0.01,
      count: 10,
    },
  };
}

function createWaveformFrame(
  kind: WaveformKind,
  channel: Channel,
  captureId: number,
  sequence = 1,
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

class FakeScopeService implements ScopeApplicationService {
  private connection: ScopeConnection = {
    kind: ScopeConnectionKind.Connected,
    info: scopeInfo,
    state: createState(),
  };
  private readonly connectionListeners = new Set<(connection: ScopeConnection) => void>();
  private readonly stateListeners = new Set<(state: ScopeState) => void>();
  private readonly waveformListeners = new Set<(frame: Uint8Array) => void>();

  public readonly setControl = vi.fn(async (_control: ControlChange) => undefined);
  public readonly updateInteraction = vi.fn(async (_control: InteractiveControl) => undefined);
  public readonly commitInteraction = vi.fn(async (_control: InteractiveControl) => undefined);
  public readonly performAcquisitionAction = vi.fn(async (_action: AcquisitionAction) => undefined);
  public readonly setMeasurements = vi.fn(async (_measurements: MeasurementSpec[]) => undefined);
  public readonly executeRawScpi = vi.fn(async (command: string) => `scope:${command}`);
  public readonly pauseLiveWaveform = vi.fn(async () => undefined);
  public readonly resumeLiveWaveform = vi.fn(() => undefined);

  public getConnection(): ScopeConnection { return this.connection; }
  public subscribeConnection(listener: (connection: ScopeConnection) => void): () => void {
    this.connectionListeners.add(listener);
    return () => this.connectionListeners.delete(listener);
  }
  public subscribeState(listener: (state: ScopeState) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }
  public subscribeWaveform(listener: (frame: Uint8Array) => void): () => void {
    this.waveformListeners.add(listener);
    return () => this.waveformListeners.delete(listener);
  }
  public async readMeasurements(measurements: NonEmptyArray<MeasurementSpec>): Promise<MeasurementValue[]> {
    return measurements.map((spec, index) => measurementValue(spec, index + 0.5));
  }
  public async captureDeep(): Promise<DeepCaptureInfo> {
    return {
      captureId: 9,
      channels: [{
        channel: Channel.Ch1,
        unit: ChannelUnit.Volts,
        sampleCount: 1_000,
        xIncrement: 1e-9,
        xOrigin: 0,
        xReference: 0,
      }],
    };
  }
  public async requestViewport(request: DeepViewportRequest): Promise<Uint8Array> {
    return createWaveformFrame(WaveformKind.DeepViewport, request.channel, request.captureId, 77);
  }
  public publishState(state: ScopeState): void {
    if (this.connection.kind === ScopeConnectionKind.Connected) {
      this.connection = { ...this.connection, state };
    }
    for (const listener of this.stateListeners) listener(state);
  }
  public publishConnection(connection: ScopeConnection): void {
    this.connection = connection;
    for (const listener of this.connectionListeners) listener(connection);
  }
  public publishWaveform(frame: Uint8Array): void {
    for (const listener of this.waveformListeners) listener(frame);
  }
}

class FakeDmmService implements DmmApplicationService {
  private connection: DmmConnection = {
    kind: DmmConnectionKind.Disconnected,
    reason: "DMM inactive",
  };
  private readonly connectionListeners = new Set<(connection: DmmConnection) => void>();
  private readonly stateListeners = new Set<(state: DmmState) => void>();
  private readonly snapshotListeners = new Set<(snapshot: DmmReadingSnapshot) => void>();
  public readonly setControl = vi.fn(async (_control: DmmControlChange) => undefined);
  public readonly executeRawScpi = vi.fn(async (command: string) => `dmm:${command}`);

  public getConnection(): DmmConnection { return this.connection; }
  public getCurrentSnapshot(): DmmReadingSnapshot | null { return null; }
  public subscribeConnection(listener: (connection: DmmConnection) => void): () => void {
    this.connectionListeners.add(listener);
    return () => this.connectionListeners.delete(listener);
  }
  public subscribeState(listener: (state: DmmState) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }
  public subscribeSnapshot(listener: (snapshot: DmmReadingSnapshot) => void): () => void {
    this.snapshotListeners.add(listener);
    return () => this.snapshotListeners.delete(listener);
  }
  public publishConnection(connection: DmmConnection): void {
    this.connection = connection;
    for (const listener of this.connectionListeners) listener(connection);
  }
}

function waitForJson(
  socket: WebSocket,
  predicate: (message: ServerJsonMessage) => boolean,
): Promise<ServerJsonMessage> {
  return new Promise((resolve) => {
    const listener = (data: RawData, isBinary: boolean) => {
      if (isBinary) return;
      const message = JSON.parse(data.toString()) as ServerJsonMessage;
      if (!predicate(message)) return;
      socket.off("message", listener);
      resolve(message);
    };
    socket.on("message", listener);
  });
}

function waitForBinary(socket: WebSocket): Promise<Uint8Array> {
  return new Promise((resolve) => {
    const listener = (data: RawData, isBinary: boolean) => {
      if (!isBinary) return;
      socket.off("message", listener);
      const bytes = data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : Array.isArray(data)
          ? Uint8Array.from(Buffer.concat(data))
          : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      resolve(Uint8Array.from(bytes));
    };
    socket.on("message", listener);
  });
}

async function listen(server: HttpServer): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return (server.address() as AddressInfo).port;
}

interface Harness {
  httpServer: HttpServer;
  gateway: WebSocketGateway;
  scopeService: FakeScopeService;
  dmmService: FakeDmmService;
  clients: WebSocket[];
  scopeStart: ReturnType<typeof vi.fn>;
  scopeStop: ReturnType<typeof vi.fn>;
  port: number;
}

let active: Harness | undefined;

afterEach(async () => {
  if (active === undefined) return;
  for (const client of active.clients) client.close();
  await active.gateway.close();
  active.httpServer.close();
  active = undefined;
});

async function createHarness(): Promise<Harness> {
  const httpServer = createServer();
  const scopeService = new FakeScopeService();
  const dmmService = new FakeDmmService();
  const scopeStart = vi.fn(async () => undefined);
  const scopeStop = vi.fn(async () => undefined);
  const instruments = new InstrumentRegistry({
    dho804: {
      endpoint: { host: "scope.test", port: 5555 },
      runtime: { start: scopeStart, stop: scopeStop },
    },
    dm858e: {
      endpoint: { host: "dmm.test", port: 5556 },
      runtime: { start: vi.fn(async () => undefined), stop: vi.fn(async () => undefined) },
    },
  });
  const gateway = new WebSocketGateway(httpServer, { instruments, scopeService, dmmService });
  const port = await listen(httpServer);
  active = { httpServer, gateway, scopeService, dmmService, clients: [], scopeStart, scopeStop, port };
  return active;
}

async function connect(server: Harness): Promise<WebSocket> {
  const client = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
  server.clients.push(client);
  const hello = waitForJson(client, (message) => message.type === MessageType.ProtocolHello);
  await once(client, "open");
  expect(await hello).toEqual({ type: MessageType.ProtocolHello, protocolVersion: PROTOCOL_VERSION });
  client.send(JSON.stringify({ type: MessageType.ProtocolHelloAck, protocolVersion: PROTOCOL_VERSION }));
  return client;
}

async function subscribe(client: WebSocket, instrument: SupportedInstrument): Promise<ServerJsonMessage> {
  const expected = instrument === SupportedInstrument.Dho804
    ? MessageType.ScopeConnected
    : MessageType.DmmDisconnected;
  const lifecycle = waitForJson(client, (message) => message.type === expected);
  client.send(JSON.stringify({ type: MessageType.InstrumentSubscribe, instrument }));
  return lifecycle;
}

describe("WebSocketGateway service routing", () => {
  it("requires the protocol handshake before application messages", async () => {
    const server = await createHarness();
    const client = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
    server.clients.push(client);
    await once(client, "open");
    const closed = once(client, "close");
    client.send(JSON.stringify({ type: MessageType.InstrumentSubscribe, instrument: SupportedInstrument.Dho804 }));
    const [code] = await closed;
    expect(code).toBe(1002);
    expect(server.scopeStart).not.toHaveBeenCalled();
  });

  it("keeps subscription lifecycle ownership in the registry and publishes service state", async () => {
    const server = await createHarness();
    const first = await connect(server);
    const second = await connect(server);
    await subscribe(first, SupportedInstrument.Dho804);
    await subscribe(second, SupportedInstrument.Dho804);
    await vi.waitFor(() => expect(server.scopeStart).toHaveBeenCalledOnce());

    const next = { ...createState(), runState: ScopeRunState.Stopped };
    const firstState = waitForJson(first, (message) => message.type === MessageType.ScopeState);
    const secondState = waitForJson(second, (message) => message.type === MessageType.ScopeState);
    server.scopeService.publishState(next);
    expect(await firstState).toMatchObject({ type: MessageType.ScopeState, state: { runState: ScopeRunState.Stopped } });
    expect(await secondState).toMatchObject({ type: MessageType.ScopeState, state: { runState: ScopeRunState.Stopped } });

    first.send(JSON.stringify({ type: MessageType.InstrumentUnsubscribe, instrument: SupportedInstrument.Dho804 }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(server.scopeStop).not.toHaveBeenCalled();
    second.send(JSON.stringify({ type: MessageType.InstrumentUnsubscribe, instrument: SupportedInstrument.Dho804 }));
    await vi.waitFor(() => expect(server.scopeStop).toHaveBeenCalledOnce());
  });

  it("routes scope controls, measurements, and raw SCPI through ScopeService", async () => {
    const server = await createHarness();
    const client = await connect(server);
    await subscribe(client, SupportedInstrument.Dho804);

    const completed = waitForJson(client, (message) => message.type === MessageType.CommandCompleted && message.requestId === 8);
    client.send(JSON.stringify({
      type: MessageType.ControlSet,
      requestId: 8,
      control: { kind: ControlKind.ChannelEnabled, channel: Channel.Ch2, value: true },
    }));
    expect(await completed).toEqual({ type: MessageType.CommandCompleted, requestId: 8 });
    expect(server.scopeService.setControl).toHaveBeenCalledOnce();

    const measurements = waitForJson(client, (message) => message.type === MessageType.MeasurementResult && message.requestId === 20);
    client.send(JSON.stringify({
      type: MessageType.MeasurementRead,
      requestId: 20,
      measurements: [{ kind: MeasurementKind.Vpp, channel: Channel.Ch2 }],
    }));
    expect(await measurements).toEqual({
      type: MessageType.MeasurementResult,
      requestId: 20,
      values: [measurementValue({ kind: MeasurementKind.Vpp, channel: Channel.Ch2 }, 0.5)],
    });

    const raw = waitForJson(client, (message) => message.type === MessageType.ScpiResult && message.requestId === 21);
    client.send(JSON.stringify({
      type: MessageType.ScpiExecute,
      requestId: 21,
      instrument: SupportedInstrument.Dho804,
      command: "*IDN?",
    }));
    expect(await raw).toEqual({ type: MessageType.ScpiResult, requestId: 21, response: "scope:*IDN?" });
  });

  it("routes DMM controls and raw SCPI through DmmService", async () => {
    const server = await createHarness();
    const client = await connect(server);
    await subscribe(client, SupportedInstrument.Dm858e);

    const done = waitForJson(client, (message) => message.type === MessageType.CommandCompleted && message.requestId === 30);
    client.send(JSON.stringify({ type: MessageType.DmmControlSet, requestId: 30, control: { kind: 1, value: 1 } }));
    expect(await done).toEqual({ type: MessageType.CommandCompleted, requestId: 30 });
    expect(server.dmmService.setControl).toHaveBeenCalledOnce();

    const raw = waitForJson(client, (message) => message.type === MessageType.ScpiResult && message.requestId === 31);
    client.send(JSON.stringify({
      type: MessageType.ScpiExecute,
      requestId: 31,
      instrument: SupportedInstrument.Dm858e,
      command: "DATA:LAST?",
    }));
    expect(await raw).toEqual({ type: MessageType.ScpiResult, requestId: 31, response: "dmm:DATA:LAST?" });
  });

  it("rejects stale DMM completion after the service connection revision changes", async () => {
    const server = await createHarness();
    let release!: () => void;
    server.dmmService.setControl.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
    const client = await connect(server);
    await subscribe(client, SupportedInstrument.Dm858e);
    const failure = waitForJson(client, (message) => message.type === MessageType.CommandFailed && message.requestId === 32);
    client.send(JSON.stringify({ type: MessageType.DmmControlSet, requestId: 32, control: { kind: 1, value: 1 } }));
    await vi.waitFor(() => expect(server.dmmService.setControl).toHaveBeenCalledOnce());
    server.dmmService.publishConnection({ kind: DmmConnectionKind.Disconnected, reason: "reconnected" });
    release();
    expect(await failure).toMatchObject({ error: expect.stringContaining("DMM connection changed") });
  });

  it("maps domain deep-capture results to wire messages and returns viewport frames", async () => {
    const server = await createHarness();
    const client = await connect(server);
    await subscribe(client, SupportedInstrument.Dho804);

    const ready = waitForJson(client, (message) => message.type === MessageType.DeepCaptureReady && message.requestId === 40);
    client.send(JSON.stringify({ type: MessageType.DeepCaptureRequest, requestId: 40 }));
    expect(await ready).toMatchObject({ type: MessageType.DeepCaptureReady, requestId: 40, captureId: 9 });

    const binary = waitForBinary(client);
    client.send(JSON.stringify({
      type: MessageType.WaveformViewportRequest,
      requestId: 41,
      captureId: 9,
      channel: Channel.Ch1,
      startSample: 0,
      endSample: 100,
      pixelWidth: 100,
    }));
    const frame = await binary;
    expect(new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(8, true)).toBe(77);
  });

  it("publishes live waveform frames only through the scope service publication surface", async () => {
    const server = await createHarness();
    const client = await connect(server);
    await subscribe(client, SupportedInstrument.Dho804);
    const binary = waitForBinary(client);
    server.scopeService.publishWaveform(createWaveformFrame(WaveformKind.Live, Channel.Ch1, 0, 12));
    const frame = await binary;
    expect(new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(8, true)).toBe(12);
  });
});
