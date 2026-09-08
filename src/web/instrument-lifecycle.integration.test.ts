import { Buffer } from "node:buffer";
import { once } from "node:events";
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket as NodeWebSocket, type RawData } from "ws";

import type { DmmControlChange, DmmReadingSnapshot, DmmState } from "../shared/dmm-types.js";
import type { MeasurementSpec, MeasurementValue } from "../shared/scope-types.js";
import type {
  AcquisitionAction,
  ControlChange,
  InteractiveControl,
  NonEmptyArray,
} from "../shared/websocket-protocol.js";
import type { DmmApplicationService } from "../server/dmm/dmm-service.js";
import {
  DmmConnectionKind,
  ScopeConnectionKind,
  type DmmConnection,
  type ScopeConnection,
} from "../server/instruments/instrument-connection.js";
import {
  InstrumentRegistry,
  type InstrumentRuntime,
} from "../server/instruments/instrument-registry.js";
import type { ScopeApplicationService } from "../server/scope/scope-service.js";
import type { DeepCaptureInfo, DeepViewportRequest } from "../server/waveform/deep-capture-service.js";
import { DmmWebSocketAdapter } from "../server/websocket/dmm-websocket-adapter.js";
import { ScopeWebSocketAdapter } from "../server/websocket/scope-websocket-adapter.js";
import { WebSocketGateway } from "../server/websocket/websocket-gateway.js";
import { bindDmmRoute } from "./dmm/dmm-route-binding.js";
import { bindScopeRoute } from "./scope-route-binding.js";
import {
  ScopeWebSocketClient,
  type WebSocketLike,
} from "./websocket-client.js";
import { WaveformController } from "./waveform/waveform-controller.js";

interface LifecycleSpy {
  runtime: InstrumentRuntime;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
}

function lifecycle(): LifecycleSpy {
  const start = vi.fn(async () => undefined);
  const stop = vi.fn(async () => undefined);
  return {
    runtime: { start, stop },
    start,
    stop,
  };
}

class ScopeServiceStub implements ScopeApplicationService {
  public getConnection(): ScopeConnection {
    return { kind: ScopeConnectionKind.Disconnected, reason: "scope inactive" };
  }
  public subscribeConnection(): () => void { return () => {}; }
  public subscribeState(): () => void { return () => {}; }
  public subscribeWaveform(): () => void { return () => {}; }
  public async setControl(_control: ControlChange): Promise<void> { throw new Error("unused"); }
  public async updateInteraction(_control: InteractiveControl): Promise<void> { throw new Error("unused"); }
  public async commitInteraction(_control: InteractiveControl): Promise<void> { throw new Error("unused"); }
  public async performAcquisitionAction(_action: AcquisitionAction): Promise<void> { throw new Error("unused"); }
  public async sleep(): Promise<void> { throw new Error("unused"); }
  public async readMeasurements(_measurements: NonEmptyArray<MeasurementSpec>): Promise<MeasurementValue[]> { throw new Error("unused"); }
  public async setMeasurements(_measurements: MeasurementSpec[]): Promise<void> { throw new Error("unused"); }
  public async executeRawScpi(_command: string): Promise<string> { throw new Error("unused"); }
  public async captureDeep(): Promise<DeepCaptureInfo> { throw new Error("unused"); }
  public async requestViewport(_request: DeepViewportRequest): Promise<Uint8Array> { throw new Error("unused"); }
  public async pauseLiveWaveform(): Promise<void> {}
  public resumeLiveWaveform(): void {}
}

class DmmServiceStub implements DmmApplicationService {
  public getConnection(): DmmConnection {
    return { kind: DmmConnectionKind.Disconnected, reason: "DMM inactive" };
  }
  public getCurrentSnapshot(): DmmReadingSnapshot | null { return null; }
  public subscribeConnection(): () => void { return () => {}; }
  public subscribeState(_listener: (state: DmmState) => void): () => void { return () => {}; }
  public subscribeSnapshot(): () => void { return () => {}; }
  public async setControl(_control: DmmControlChange): Promise<void> { throw new Error("unused"); }
  public async executeRawScpi(_command: string): Promise<string> { throw new Error("unused"); }
}

function binaryData(data: RawData): ArrayBuffer {
  const buffer = Array.isArray(data)
    ? Buffer.concat(data)
    : data instanceof ArrayBuffer
      ? Buffer.from(data)
      : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
}

class NodeSocketAdapter implements WebSocketLike {
  public binaryType: BinaryType = "arraybuffer";
  public onopen: (() => void) | null = null;
  public onmessage: ((event: { data: string | ArrayBuffer }) => void) | null = null;
  public onclose: ((event: { reason: string }) => void) | null = null;
  public onerror: (() => void) | null = null;
  private readonly socket: NodeWebSocket;

  public constructor(url: string) {
    this.socket = new NodeWebSocket(url);
    this.socket.on("open", () => this.onopen?.());
    this.socket.on("message", (data, isBinary) => {
      this.onmessage?.({ data: isBinary ? binaryData(data) : data.toString() });
    });
    this.socket.on("close", (_code, reason) => this.onclose?.({ reason: reason.toString() }));
    this.socket.on("error", () => this.onerror?.());
  }
  public get readyState(): number { return this.socket.readyState; }
  public send(data: string): void { this.socket.send(data); }
  public close(code?: number, reason?: string): void { this.socket.close(code, reason); }
  public terminate(): void { this.socket.terminate(); }
}

interface Harness {
  httpServer: HttpServer;
  gateway: WebSocketGateway;
  instruments: InstrumentRegistry;
  scopeLifecycle: LifecycleSpy;
  dmmLifecycle: LifecycleSpy;
  clients: ScopeWebSocketClient[];
  adapters: NodeSocketAdapter[];
  createClient(): ScopeWebSocketClient;
}

let active: Harness | undefined;

beforeEach(() => {
  vi.stubGlobal("window", {
    setTimeout: (callback: () => void) => globalThis.setTimeout(callback, 0),
    clearTimeout: (handle: ReturnType<typeof setTimeout>) => globalThis.clearTimeout(handle),
    setInterval: (callback: () => void, delay?: number) => globalThis.setInterval(callback, delay),
    clearInterval: (handle: ReturnType<typeof setInterval>) => globalThis.clearInterval(handle),
  });
});

afterEach(async () => {
  if (active !== undefined) {
    for (const client of active.clients) client.dispose();
    await active.gateway.close();
    await active.instruments.stopAll();
    await new Promise<void>((resolve, reject) => {
      active?.httpServer.close((error) => error === undefined ? resolve() : reject(error));
    });
    active = undefined;
  }
  vi.unstubAllGlobals();
});

async function createHarness(): Promise<Harness> {
  const httpServer = createServer();
  const scopeLifecycle = lifecycle();
  const dmmLifecycle = lifecycle();
  const instruments = new InstrumentRegistry({
    dho804: scopeLifecycle.runtime,
    dm858e: dmmLifecycle.runtime,
  });
  await instruments.startAll();

  const scopeService = new ScopeServiceStub();
  const dmmService = new DmmServiceStub();
  const gateway = new WebSocketGateway(httpServer, {
    scopeAdapter: new ScopeWebSocketAdapter(scopeService),
    dmmAdapter: new DmmWebSocketAdapter(dmmService),
  });

  httpServer.listen(0, "127.0.0.1");
  await once(httpServer, "listening");
  const port = (httpServer.address() as AddressInfo).port;
  const clients: ScopeWebSocketClient[] = [];
  const adapters: NodeSocketAdapter[] = [];
  const harness: Harness = {
    httpServer,
    gateway,
    instruments,
    scopeLifecycle,
    dmmLifecycle,
    clients,
    adapters,
    createClient: () => {
      const client = new ScopeWebSocketClient(
        new WaveformController(() => 0),
        (url) => {
          const adapter = new NodeSocketAdapter(url);
          adapters.push(adapter);
          return adapter;
        },
        () => `ws://127.0.0.1:${port}/ws`,
      );
      clients.push(client);
      client.connect();
      return client;
    },
  };
  active = harness;
  return harness;
}

async function settle(): Promise<void> {
  await new Promise((resolve) => globalThis.setTimeout(resolve, 20));
}

describe("server-owned instrument lifetime through browser routes", () => {
  it("starts both runtimes before any browser subscribes and route switching does not restart them", async () => {
    const harness = await createHarness();
    expect(harness.scopeLifecycle.start).toHaveBeenCalledOnce();
    expect(harness.dmmLifecycle.start).toHaveBeenCalledOnce();

    const client = harness.createClient();
    const leaveScope = bindScopeRoute(client);
    await settle();
    leaveScope();
    const leaveDmm = bindDmmRoute(client);
    await settle();
    leaveDmm();
    const leaveScopeAgain = bindScopeRoute(client);
    await settle();

    expect(harness.scopeLifecycle.start).toHaveBeenCalledOnce();
    expect(harness.dmmLifecycle.start).toHaveBeenCalledOnce();
    expect(harness.scopeLifecycle.stop).not.toHaveBeenCalled();
    expect(harness.dmmLifecycle.stop).not.toHaveBeenCalled();
    leaveScopeAgain();
  });

  it("does not stop the scope runtime when the last subscribed tab leaves", async () => {
    const harness = await createHarness();
    const first = harness.createClient();
    const second = harness.createClient();
    const leaveFirst = bindScopeRoute(first);
    const leaveSecond = bindScopeRoute(second);
    await settle();

    leaveFirst();
    leaveSecond();
    await settle();

    expect(harness.scopeLifecycle.start).toHaveBeenCalledOnce();
    expect(harness.scopeLifecycle.stop).not.toHaveBeenCalled();
  });

  it("does not stop either runtime when browser sockets close", async () => {
    const harness = await createHarness();
    const scopeClient = harness.createClient();
    const dmmClient = harness.createClient();
    bindScopeRoute(scopeClient);
    bindDmmRoute(dmmClient);
    await settle();

    scopeClient.dispose();
    dmmClient.dispose();
    await settle();

    expect(harness.scopeLifecycle.stop).not.toHaveBeenCalled();
    expect(harness.dmmLifecycle.stop).not.toHaveBeenCalled();
  });

  it("reconnects browser transport without restarting physical runtimes", async () => {
    const harness = await createHarness();
    const client = harness.createClient();
    const leaveScope = bindScopeRoute(client);
    await vi.waitFor(() => expect(harness.adapters.length).toBe(1));

    harness.adapters.at(-1)?.terminate();
    await vi.waitFor(() => expect(harness.adapters.length).toBeGreaterThanOrEqual(2));
    await settle();

    expect(harness.scopeLifecycle.start).toHaveBeenCalledOnce();
    expect(harness.dmmLifecycle.start).toHaveBeenCalledOnce();
    expect(harness.scopeLifecycle.stop).not.toHaveBeenCalled();
    expect(harness.dmmLifecycle.stop).not.toHaveBeenCalled();
    leaveScope();
  });
});
