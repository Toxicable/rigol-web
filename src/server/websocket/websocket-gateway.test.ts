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
    readMeasurements: async (specs: MeasurementSpec[]) => specs.map((spec, index) => ({
      ...spec,
      value: index + 0.5,
    })),
    executeRawScpi: async (command) => `response:${command}`,
  } as ScopeControllerDriver;
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
  it("requires the v2 handshake before application messages", async () => {
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
        { kind: MeasurementKind.Vpp, channel: Channel.Ch2, value: 0.5 },
        { kind: MeasurementKind.Frequency, channel: Channel.Ch1, value: 1.5 },
      ],
    });

    const scpi = waitForJson(client, (message) => message.type === MessageType.ScpiResult && message.requestId === 21);
    client.send(JSON.stringify({
      type: MessageType.ScpiExecute,
      requestId: 21,
      instrument: SupportedInstrument.Dho804,
      command: "*IDN?",
    }));
    expect(await scpi).toEqual({
      type: MessageType.ScpiResult,
      requestId: 21,
      response: "response:*IDN?",
    });

    await subscribe(client, SupportedInstrument.Dm858e);
    const dmmScpi = waitForJson(client, (message) => message.type === MessageType.ScpiResult && message.requestId === 22);
    client.send(JSON.stringify({
      type: MessageType.ScpiExecute,
      requestId: 22,
      instrument: SupportedInstrument.Dm858e,
      command: "*IDN?",
    }));
    expect(await dmmScpi).toEqual({
      type: MessageType.ScpiResult,
      requestId: 22,
      response: "dmm:*IDN?",
    });
  });

  it("dispatches deep capture and viewport requests and publishes binary live frames", async () => {
    const server = await createTestServer();
    const client = await connect(server);
    await subscribe(client, SupportedInstrument.Dho804);

    const ready = waitForJson(client, (message) => message.type === MessageType.DeepCaptureReady && message.requestId === 30);
    client.send(JSON.stringify({ type: MessageType.DeepCaptureRequest, requestId: 30 }));
    expect(await ready).toMatchObject({ type: MessageType.DeepCaptureReady, requestId: 30, captureId: 1 });

    const viewport = waitForBinary(client);
    client.send(JSON.stringify({
      type: MessageType.WaveformViewportRequest,
      requestId: 31,
      captureId: 1,
      channel: Channel.Ch1,
      startSample: 0,
      endSample: 100,
      pixelWidth: 50,
    }));
    expect(new DataView((await viewport).buffer).getUint8(5)).toBe(WaveformKind.DeepViewport);

    const live = waitForBinary(client);
    server.gateway.broadcastWaveform(createWaveformFrame(WaveformKind.Live, Channel.Ch2, 0));
    const liveFrame = await live;
    expect(new DataView(liveFrame.buffer).getUint8(5)).toBe(WaveformKind.Live);
    expect(new DataView(liveFrame.buffer).getUint8(6)).toBe(Channel.Ch2);
  });

  it("fails superseded viewport requests instead of sending stale binary", async () => {
    const resolvers = new Map<number, (frame: Uint8Array) => void>();
    const handlers: WaveformRequestHandlers = {
      requestDeepCapture: vi.fn(),
      requestViewport: (request: WaveformViewportRequestMessage) => new Promise((resolve) => {
        resolvers.set(request.requestId, resolve);
      }),
    };
    const server = await createTestServer(handlers);
    const client = await connect(server);
    await subscribe(client, SupportedInstrument.Dho804);

    const superseded = waitForJson(client, (message) => message.type === MessageType.CommandFailed && message.requestId === 40);
    client.send(JSON.stringify({
      type: MessageType.WaveformViewportRequest,
      requestId: 40,
      captureId: 1,
      channel: Channel.Ch1,
      startSample: 0,
      endSample: 100,
      pixelWidth: 50,
    }));
    client.send(JSON.stringify({
      type: MessageType.WaveformViewportRequest,
      requestId: 41,
      captureId: 1,
      channel: Channel.Ch1,
      startSample: 50,
      endSample: 150,
      pixelWidth: 50,
    }));

    await vi.waitFor(() => expect(resolvers.size).toBe(2));
    resolvers.get(40)!(createWaveformFrame(WaveformKind.DeepViewport, Channel.Ch1, 1));
    expect(await superseded).toMatchObject({ requestId: 40, error: expect.stringContaining("superseded") });

    const latest = waitForBinary(client);
    resolvers.get(41)!(createWaveformFrame(WaveformKind.DeepViewport, Channel.Ch1, 1, 2));
    expect(new DataView((await latest).buffer).getUint32(8, true)).toBe(2);
  });

  it("keeps viewport supersession independent per channel", async () => {
    const resolvers = new Map<number, (frame: Uint8Array) => void>();
    const handlers: WaveformRequestHandlers = {
      requestDeepCapture: vi.fn(),
      requestViewport: (request: WaveformViewportRequestMessage) => new Promise((resolve) => {
        resolvers.set(request.requestId, resolve);
      }),
    };
    const server = await createTestServer(handlers);
    const client = await connect(server);
    await subscribe(client, SupportedInstrument.Dho804);

    const ch1Result = Promise.race([
      waitForBinary(client).then((frame) => ({ kind: "binary" as const, frame })),
      waitForJson(
        client,
        (message) => message.type === MessageType.CommandFailed && message.requestId === 42,
      ).then((message) => ({ kind: "failure" as const, message })),
    ]);

    client.send(JSON.stringify({
      type: MessageType.WaveformViewportRequest,
      requestId: 42,
      captureId: 1,
      channel: Channel.Ch1,
      startSample: 0,
      endSample: 100,
      pixelWidth: 50,
    }));
    client.send(JSON.stringify({
      type: MessageType.WaveformViewportRequest,
      requestId: 43,
      captureId: 1,
      channel: Channel.Ch2,
      startSample: 0,
      endSample: 100,
      pixelWidth: 50,
    }));

    await vi.waitFor(() => expect(resolvers.size).toBe(2));
    resolvers.get(42)!(createWaveformFrame(WaveformKind.DeepViewport, Channel.Ch1, 1, 3));

    const firstResult = await ch1Result;
    expect(firstResult.kind).toBe("binary");
    if (firstResult.kind !== "binary") {
      throw new Error("CH1 viewport was incorrectly superseded by CH2");
    }
    expect(new DataView(firstResult.frame.buffer).getUint8(6)).toBe(Channel.Ch1);

    const ch2 = waitForBinary(client);
    resolvers.get(43)!(createWaveformFrame(WaveformKind.DeepViewport, Channel.Ch2, 1, 4));
    expect(new DataView((await ch2).buffer).getUint8(6)).toBe(Channel.Ch2);
  });

  it("replaces pending live frames and drops them when a newer frame can send directly", async () => {
    const server = await createTestServer();
    let bufferedAmount = 300_000;
    const send = vi.fn();
    const socket = {
      readyState: WebSocket.OPEN,
      get bufferedAmount() {
        return bufferedAmount;
      },
      send,
    } as unknown as WebSocket;
    const client = {
      socket,
      protocolReady: true,
      subscriptions: new Set([SupportedInstrument.Dho804]),
      pendingLiveFrames: new Map<Channel, Uint8Array>(),
      liveSendInFlight: false,
      viewportGenerations: new Map<Channel, number>(),
    };
    const queueLiveFrame = (server.gateway as unknown as {
      queueLiveFrame(
        clientState: typeof client,
        channel: Channel,
        frame: Uint8Array,
      ): void;
    }).queueLiveFrame.bind(server.gateway);
    const first = createWaveformFrame(WaveformKind.Live, Channel.Ch1, 0, 10);
    const pendingLatest = createWaveformFrame(WaveformKind.Live, Channel.Ch1, 0, 11);
    const directLatest = createWaveformFrame(WaveformKind.Live, Channel.Ch1, 0, 12);

    queueLiveFrame(client, Channel.Ch1, first);
    queueLiveFrame(client, Channel.Ch1, pendingLatest);
    expect(client.pendingLiveFrames.size).toBe(1);
    expect(client.pendingLiveFrames.get(Channel.Ch1)).toBe(pendingLatest);

    bufferedAmount = 0;
    queueLiveFrame(client, Channel.Ch1, directLatest);

    expect(client.pendingLiveFrames.has(Channel.Ch1)).toBe(false);
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]?.[0]).toBe(directLatest);
  });
});
