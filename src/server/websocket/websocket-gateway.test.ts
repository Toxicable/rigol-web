import { once } from "node:events";
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket, type RawData } from "ws";

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
  ControlKind,
  MessageType,
  PROTOCOL_VERSION,
  WaveformKind,
  type DeepCaptureReadyMessage,
  type ServerJsonMessage,
  type WaveformViewportRequestMessage,
} from "../../shared/websocket-protocol.js";
import { InstrumentRegistry } from "../instruments/instrument-registry.js";
import {
  ScopeController,
  type ScopeControllerDriver,
} from "../scope/scope-controller.js";
import { ScopeStateStore } from "../scope/scope-state-store.js";
import {
  ServerDmmConnectionKind,
  ServerScopeConnectionKind,
  WebSocketGateway,
  type DmmRequestHandlers,
  type WaveformRequestHandlers,
} from "./websocket-gateway.js";

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

function createDriver(initial: ScopeState): ScopeControllerDriver {
  let state = initial;
  const unused = async (): Promise<never> => {
    throw new Error("unused fake driver operation");
  };

  return {
    readScopeState: async () => state,
    readChannelState: async (channel) => state.channels[channel - 1]!,
    readHorizontalState: async () => state.horizontal,
    readAcquisitionState: async () => state.acquisition,
    readTriggerState: async () => state.trigger,
    readRunState: async () => state.runState,
    setChannelEnabled: async (channel, enabled) => {
      const channels = [...state.channels] as ScopeState["channels"];
      channels[channel - 1] = { ...channels[channel - 1]!, enabled };
      state = { ...state, channels };
    },
    setChannelScale: unused,
    setChannelOffset: unused,
    setHorizontalScale: unused,
    setHorizontalPosition: unused,
    setTriggerType: unused,
    setTriggerSource: unused,
    setTriggerSlope: unused,
    setTriggerLevel: unused,
    run: unused,
    stop: unused,
    single: unused,
    readMeasurements: async (specs: MeasurementSpec[]) => specs.map(
      (spec, index) => measurementValue(spec, index + 0.5),
    ),
    setMeasurements: async () => undefined,
    executeRawScpi: async (command) => `response:${command}`,
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

      if (Array.isArray(data)) {
        const byteLength = data.reduce((total, part) => total + part.byteLength, 0);
        const bytes = new Uint8Array(byteLength);
        let offset = 0;
        for (const part of data) {
          bytes.set(part, offset);
          offset += part.byteLength;
        }
        resolve(bytes);
        return;
      }

      const bytes = data instanceof ArrayBuffer
        ? new Uint8Array(data)
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

interface TestServer {
  httpServer: HttpServer;
  gateway: WebSocketGateway;
  store: ScopeStateStore;
  clients: WebSocket[];
  scopeStart: ReturnType<typeof vi.fn>;
  scopeStop: ReturnType<typeof vi.fn>;
  dmmHandlers: DmmRequestHandlers;
}

let active: TestServer | undefined;

afterEach(async () => {
  if (active === undefined) return;
  for (const client of active.clients) client.close();
  await active.gateway.close();
  active.httpServer.close();
  active = undefined;
});

async function createTestServer(
  waveformHandlers?: WaveformRequestHandlers,
): Promise<TestServer & { port: number }> {
  const state = createState();
  const store = new ScopeStateStore(state);
  const controller = new ScopeController(createDriver(state), store);
  const httpServer = createServer();
  const handlers: WaveformRequestHandlers = waveformHandlers ?? {
    requestDeepCapture: async (requestId): Promise<DeepCaptureReadyMessage> => ({
      type: MessageType.DeepCaptureReady,
      requestId,
      captureId: 1,
      channels: [{
        channel: Channel.Ch1,
        unit: ChannelUnit.Volts,
        sampleCount: 1_000,
        xIncrement: 1e-9,
        xOrigin: 0,
        xReference: 0,
      }],
    }),
    requestViewport: async (request) => createWaveformFrame(
      WaveformKind.DeepViewport,
      request.channel,
      request.captureId,
    ),
  };
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
  const dmmHandlers: DmmRequestHandlers = {
    setControl: vi.fn(async () => undefined),
    executeRawScpi: vi.fn(async (command: string) => `dmm:${command}`),
  };
  const gateway = new WebSocketGateway(
    httpServer,
    {
      kind: ServerScopeConnectionKind.Connected,
      info: scopeInfo,
      stateStore: store,
      controller,
    },
    {
      instruments,
      initialDmmConnection: {
        kind: ServerDmmConnectionKind.Disconnected,
        reason: "DMM inactive",
      },
      waveformHandlers: handlers,
      dmmHandlers,
    },
  );
  const port = await listen(httpServer);
  active = { httpServer, gateway, store, clients: [], scopeStart, scopeStop, dmmHandlers };
  return { ...active, port };
}

async function connect(server: TestServer & { port: number }): Promise<WebSocket> {
  const client = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
  server.clients.push(client);
  const hello = waitForJson(client, (message) => message.type === MessageType.ProtocolHello);
  await once(client, "open");
  expect(await hello).toEqual({
    type: MessageType.ProtocolHello,
    protocolVersion: PROTOCOL_VERSION,
  });
  client.send(JSON.stringify({
    type: MessageType.ProtocolHelloAck,
    protocolVersion: PROTOCOL_VERSION,
  }));
  return client;
}

async function subscribe(
  client: WebSocket,
  instrument: SupportedInstrument,
): Promise<ServerJsonMessage> {
  const expectedType = instrument === SupportedInstrument.Dho804
    ? MessageType.ScopeConnected
    : MessageType.DmmDisconnected;
  const lifecycle = waitForJson(client, (message) => message.type === expectedType);
  client.send(JSON.stringify({ type: MessageType.InstrumentSubscribe, instrument }));
  return lifecycle;
}

describe("WebSocketGateway", () => {
  it("requires the protocol handshake before application messages", async () => {
    const server = await createTestServer();
    const client = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
    server.clients.push(client);
    const hello = waitForJson(client, (message) => message.type === MessageType.ProtocolHello);
    await once(client, "open");
    await hello;

    const closed = once(client, "close");
    client.send(JSON.stringify({
      type: MessageType.InstrumentSubscribe,
      instrument: SupportedInstrument.Dho804,
    }));
    const [code] = await closed;
    expect(code).toBe(1002);
    expect(server.scopeStart).not.toHaveBeenCalled();
  });

  it("publishes lifecycle/state only after route subscription and shares one runtime", async () => {
    const server = await createTestServer();
    const first = await connect(server);
    const second = await connect(server);

    expect(server.scopeStart).not.toHaveBeenCalled();
    expect((await subscribe(first, SupportedInstrument.Dho804)).type).toBe(MessageType.ScopeConnected);
    expect((await subscribe(second, SupportedInstrument.Dho804)).type).toBe(MessageType.ScopeConnected);
    await vi.waitFor(() => expect(server.scopeStart).toHaveBeenCalledOnce());

    const firstState = waitForJson(first, (message) => message.type === MessageType.ScopeState);
    const secondState = waitForJson(second, (message) => message.type === MessageType.ScopeState);
    server.store.update((state) => ({ ...state, runState: ScopeRunState.Stopped }));

    expect(await firstState).toMatchObject({ type: MessageType.ScopeState, state: { runState: ScopeRunState.Stopped } });
    expect(await secondState).toMatchObject({ type: MessageType.ScopeState, state: { runState: ScopeRunState.Stopped } });

    first.send(JSON.stringify({
      type: MessageType.InstrumentUnsubscribe,
      instrument: SupportedInstrument.Dho804,
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(server.scopeStop).not.toHaveBeenCalled();

    second.send(JSON.stringify({
      type: MessageType.InstrumentUnsubscribe,
      instrument: SupportedInstrument.Dho804,
    }));
    await vi.waitFor(() => expect(server.scopeStop).toHaveBeenCalledOnce());
  });

  it("rejects scope commands from a session that is not subscribed", async () => {
    const server = await createTestServer();
    const client = await connect(server);

    const failure = waitForJson(
      client,
      (message) => message.type === MessageType.CommandFailed && message.requestId === 6,
    );
    client.send(JSON.stringify({
      type: MessageType.ControlSet,
      requestId: 6,
      control: { kind: ControlKind.ChannelEnabled, channel: Channel.Ch1, value: true },
    }));

    expect(await failure).toMatchObject({
      type: MessageType.CommandFailed,
      requestId: 6,
      error: expect.stringContaining("not subscribed"),
    });
  });

  it("validates JSON and preserves request IDs for failures and completions", async () => {
    const server = await createTestServer();
    const client = await connect(server);
    await subscribe(client, SupportedInstrument.Dho804);

    const invalid = waitForJson(client, (message) => message.type === MessageType.CommandFailed && message.requestId === 7);
    client.send(JSON.stringify({
      type: MessageType.ControlSet,
      requestId: 7,
      control: { kind: ControlKind.ChannelEnabled, channel: 9, value: true },
    }));
    expect(await invalid).toMatchObject({ type: MessageType.CommandFailed, requestId: 7 });

    const completed = waitForJson(client, (message) => message.type === MessageType.CommandCompleted && message.requestId === 8);
    client.send(JSON.stringify({
      type: MessageType.ControlSet,
      requestId: 8,
      control: { kind: ControlKind.ChannelEnabled, channel: Channel.Ch2, value: true },
    }));
    expect(await completed).toEqual({ type: MessageType.CommandCompleted, requestId: 8 });
  });

  it("returns measurements and instrument-targeted raw SCPI results", async () => {
    const server = await createTestServer();
    const client = await connect(server);
    await subscribe(client, SupportedInstrument.Dho804);

    const measurements = waitForJson(client, (message) => message.type === MessageType.MeasurementResult && message.requestId === 20);
    client.send(JSON.stringify({
      type: MessageType.MeasurementRead,
      requestId: 20,
      measurements: [
        { kind: MeasurementKind.Vpp, channel: Channel.Ch2 },
        { kind: MeasurementKind.Frequency, channel: Channel.Ch1 },
      ],
    }));
    expect(await measurements).toEqual({
      type: MessageType.MeasurementResult,
      requestId: 20,
      values: [
        measurementValue({ kind: MeasurementKind.Vpp, channel: Channel.Ch2 }, 0.5),
        measurementValue({ kind: MeasurementKind.Frequency, channel: Channel.Ch1 }, 1.5),
      ],
    });

    const rawResult = waitForJson(client, (message) => message.type === MessageType.ScpiResult && message.requestId === 21);
    client.send(JSON.stringify({
      type: MessageType.ScpiExecute,
      requestId: 21,
      instrument: SupportedInstrument.Dho804,
      command: "*IDN?",
    }));
    expect(await rawResult).toEqual({
      type: MessageType.ScpiResult,
      requestId: 21,
      response: "response:*IDN?",
    });
  });

  it("rejects raw SCPI when the client is not subscribed to the requested instrument", async () => {
    const server = await createTestServer();
    const client = await connect(server);
    const failure = waitForJson(client, (message) => message.type === MessageType.CommandFailed && message.requestId === 22);

    client.send(JSON.stringify({
      type: MessageType.ScpiExecute,
      requestId: 22,
      instrument: SupportedInstrument.Dm858e,
      command: "*IDN?",
    }));

    expect(await failure).toMatchObject({
      type: MessageType.CommandFailed,
      requestId: 22,
      error: expect.stringContaining("not subscribed"),
    });
  });

  it("routes DMM control and raw SCPI only for DM858E subscribers", async () => {
    const server = await createTestServer();
    const client = await connect(server);
    await subscribe(client, SupportedInstrument.Dm858e);

    const controlDone = waitForJson(client, (message) => (
      message.type === MessageType.CommandCompleted && message.requestId === 30
    ));
    client.send(JSON.stringify({
      type: MessageType.DmmControlSet,
      requestId: 30,
      control: { kind: 1, value: 1 },
    }));
    expect(await controlDone).toEqual({ type: MessageType.CommandCompleted, requestId: 30 });
    expect(server.dmmHandlers.setControl).toHaveBeenCalledOnce();

    const scpiResult = waitForJson(client, (message) => (
      message.type === MessageType.ScpiResult && message.requestId === 31
    ));
    client.send(JSON.stringify({
      type: MessageType.ScpiExecute,
      requestId: 31,
      instrument: SupportedInstrument.Dm858e,
      command: "DATA:LAST?",
    }));
    expect(await scpiResult).toEqual({
      type: MessageType.ScpiResult,
      requestId: 31,
      response: "dmm:DATA:LAST?",
    });
  });

  it("rejects stale DMM command completion after the connection revision changes", async () => {
    const server = await createTestServer();
    let resolveControl!: () => void;
    server.dmmHandlers.setControl = vi.fn(() => new Promise<void>((resolve) => {
      resolveControl = resolve;
    }));
    const client = await connect(server);
    await subscribe(client, SupportedInstrument.Dm858e);

    const failure = waitForJson(client, (message) => (
      message.type === MessageType.CommandFailed && message.requestId === 32
    ));
    client.send(JSON.stringify({
      type: MessageType.DmmControlSet,
      requestId: 32,
      control: { kind: 1, value: 1 },
    }));
    await vi.waitFor(() => expect(server.dmmHandlers.setControl).toHaveBeenCalledOnce());
    server.gateway.setDmmConnection({
      kind: ServerDmmConnectionKind.Disconnected,
      reason: "reconnected",
    });
    resolveControl();

    expect(await failure).toMatchObject({
      type: MessageType.CommandFailed,
      requestId: 32,
      error: expect.stringContaining("DMM connection changed"),
    });
  });

  it("rejects stale DMM raw-SCPI completion after the connection revision changes", async () => {
    const server = await createTestServer();
    let resolveScpi!: (response: string) => void;
    server.dmmHandlers.executeRawScpi = vi.fn(() => new Promise<string>((resolve) => {
      resolveScpi = resolve;
    }));
    const client = await connect(server);
    await subscribe(client, SupportedInstrument.Dm858e);

    const failure = waitForJson(client, (message) => (
      message.type === MessageType.CommandFailed && message.requestId === 33
    ));
    client.send(JSON.stringify({
      type: MessageType.ScpiExecute,
      requestId: 33,
      instrument: SupportedInstrument.Dm858e,
      command: "*IDN?",
    }));
    await vi.waitFor(() => expect(server.dmmHandlers.executeRawScpi).toHaveBeenCalledOnce());
    server.gateway.setDmmConnection({
      kind: ServerDmmConnectionKind.Disconnected,
      reason: "reconnected",
    });
    resolveScpi("late-response");

    expect(await failure).toMatchObject({
      type: MessageType.CommandFailed,
      requestId: 33,
      error: expect.stringContaining("DMM connection changed"),
    });
  });

  it("keeps only the newest pending live frame per channel while a send is in flight", async () => {
    const server = await createTestServer();
    const client = await connect(server);
    await subscribe(client, SupportedInstrument.Dho804);

    const internal = server.gateway as unknown as {
      clients: Map<WebSocket, {
        socket: { readyState: number; send: (data: Uint8Array, options: unknown, callback: (error?: Error) => void) => void };
        protocolReady: boolean;
        subscriptions: Set<SupportedInstrument>;
        pendingLiveFrames: Map<Channel, Uint8Array>;
        liveSendInFlight: boolean;
        viewportGenerations: Map<Channel, number>;
      }>;
    };
    const state = internal.clients.get(client);
    if (state === undefined) throw new Error("missing test client");

    const callbacks: Array<(error?: Error) => void> = [];
    const sends: Uint8Array[] = [];
    state.socket = {
      readyState: WebSocket.OPEN,
      send: (data, _options, callback) => {
        sends.push(data);
        callbacks.push(callback);
      },
    };

    server.gateway.broadcastWaveform(createWaveformFrame(WaveformKind.Live, Channel.Ch1, 0, 1));
    server.gateway.broadcastWaveform(createWaveformFrame(WaveformKind.Live, Channel.Ch1, 0, 2));
    server.gateway.broadcastWaveform(createWaveformFrame(WaveformKind.Live, Channel.Ch1, 0, 3));

    expect(sends).toHaveLength(1);
    expect(readSequence(sends[0]!)).toBe(1);

    callbacks.shift()?.();
    expect(sends).toHaveLength(2);
    expect(readSequence(sends[1]!)).toBe(3);
    callbacks.shift()?.();
  });

  it("supersedes older viewport responses for the same channel", async () => {
    const pending = new Map<number, (frame: Uint8Array) => void>();
    const server = await createTestServer({
      requestDeepCapture: async () => { throw new Error("unused"); },
      requestViewport: (request: WaveformViewportRequestMessage) => new Promise((resolve) => {
        pending.set(request.requestId, resolve);
      }),
    });
    const client = await connect(server);
    await subscribe(client, SupportedInstrument.Dho804);

    const request = (requestId: number, startSample: number): void => {
      client.send(JSON.stringify({
        type: MessageType.WaveformViewportRequest,
        requestId,
        captureId: 9,
        channel: Channel.Ch1,
        startSample,
        endSample: startSample + 100,
        pixelWidth: 100,
      }));
    };

    request(40, 0);
    request(41, 100);
    await vi.waitFor(() => expect(pending.size).toBe(2));

    const newer = waitForBinary(client);
    pending.get(41)?.(createWaveformFrame(WaveformKind.DeepViewport, Channel.Ch1, 9, 41));
    expect(readSequence(await newer)).toBe(41);

    pending.get(40)?.(createWaveformFrame(WaveformKind.DeepViewport, Channel.Ch1, 9, 40));
    const unexpected = await Promise.race([
      waitForBinary(client).then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 50)),
    ]);
    expect(unexpected).toBe(false);
  });
});

function readSequence(frame: Uint8Array): number {
  return new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(8, true);
}
