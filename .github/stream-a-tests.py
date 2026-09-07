from pathlib import Path

Path('src/web/instrument-lifecycle.integration.test.ts').write_text(r'''import { Buffer } from "node:buffer";
import { once } from "node:events";
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket as NodeWebSocket, type RawData } from "ws";

import type { DmmControlChange, DmmReadingSnapshot, DmmState } from "../shared/dmm-types.js";
import { SupportedInstrument } from "../shared/instrument-types.js";
import type { MeasurementSpec, MeasurementValue, ScopeState } from "../shared/scope-types.js";
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
  subscriberAdded: ReturnType<typeof vi.fn>;
}

function lifecycle(): LifecycleSpy {
  const start = vi.fn(async () => undefined);
  const stop = vi.fn(async () => undefined);
  return {
    runtime: { start, stop },
    start,
    stop,
    subscriberAdded: vi.fn(async () => undefined),
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
    dho804: {
      endpoint: { host: "scope.test", port: 5555 },
      runtime: scopeLifecycle.runtime,
      subscriberAdded: scopeLifecycle.subscriberAdded,
    },
    dm858e: {
      endpoint: { host: "dmm.test", port: 5556 },
      runtime: dmmLifecycle.runtime,
      subscriberAdded: dmmLifecycle.subscriberAdded,
    },
  });
  const gateway = new WebSocketGateway(httpServer, {
    instruments,
    scopeService: new ScopeServiceStub(),
    dmmService: new DmmServiceStub(),
  });

  httpServer.listen(0, "127.0.0.1");
  await once(httpServer, "listening");
  const port = (httpServer.address() as AddressInfo).port;
  const clients: ScopeWebSocketClient[] = [];
  const adapters: NodeSocketAdapter[] = [];
  const harness: Harness = {
    httpServer,
    gateway,
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

function runningDelta(spy: LifecycleSpy): number {
  return spy.start.mock.calls.length - spy.stop.mock.calls.length;
}

describe("route lifecycle through browser WebSocket and gateway", () => {
  it("switches scope to DMM to scope through the actual route binders", async () => {
    const harness = await createHarness();
    const client = harness.createClient();
    const leaveScope = bindScopeRoute(client);
    await vi.waitFor(() => expect(harness.scopeLifecycle.subscriberAdded).toHaveBeenCalledOnce());

    leaveScope();
    const leaveDmm = bindDmmRoute(client);
    await vi.waitFor(() => {
      expect(harness.scopeLifecycle.stop).toHaveBeenCalledOnce();
      expect(harness.dmmLifecycle.subscriberAdded).toHaveBeenCalledOnce();
    });

    leaveDmm();
    const leaveScopeAgain = bindScopeRoute(client);
    await vi.waitFor(() => {
      expect(harness.dmmLifecycle.stop).toHaveBeenCalledOnce();
      expect(harness.scopeLifecycle.subscriberAdded).toHaveBeenCalledTimes(2);
      expect(runningDelta(harness.scopeLifecycle)).toBe(1);
      expect(runningDelta(harness.dmmLifecycle)).toBe(0);
    });
    leaveScopeAgain();
  });

  it("keeps one shared scope runtime alive until the last tab leaves", async () => {
    const harness = await createHarness();
    const first = harness.createClient();
    const second = harness.createClient();
    const leaveFirst = bindScopeRoute(first);
    const leaveSecond = bindScopeRoute(second);
    await vi.waitFor(() => {
      expect(harness.scopeLifecycle.start).toHaveBeenCalledOnce();
      expect(harness.scopeLifecycle.subscriberAdded).toHaveBeenCalledTimes(2);
    });
    leaveFirst();
    await new Promise((resolve) => globalThis.setTimeout(resolve, 20));
    expect(harness.scopeLifecycle.stop).not.toHaveBeenCalled();
    leaveSecond();
    await vi.waitFor(() => expect(harness.scopeLifecycle.stop).toHaveBeenCalledOnce());
  });

  it("keeps scope and DMM tabs independent and releases a runtime on socket close", async () => {
    const harness = await createHarness();
    const scopeClient = harness.createClient();
    const dmmClient = harness.createClient();
    bindScopeRoute(scopeClient);
    bindDmmRoute(dmmClient);
    await vi.waitFor(() => {
      expect(harness.scopeLifecycle.subscriberAdded).toHaveBeenCalledOnce();
      expect(harness.dmmLifecycle.subscriberAdded).toHaveBeenCalledOnce();
    });
    scopeClient.dispose();
    await vi.waitFor(() => expect(harness.scopeLifecycle.stop).toHaveBeenCalledOnce());
    expect(harness.dmmLifecycle.stop).not.toHaveBeenCalled();
    expect(runningDelta(harness.dmmLifecycle)).toBe(1);
    dmmClient.dispose();
    await vi.waitFor(() => expect(harness.dmmLifecycle.stop).toHaveBeenCalledOnce());
  });

  it("reconnects with only the final desired subscription after rapid switching", async () => {
    const harness = await createHarness();
    const client = harness.createClient();
    const leaveScope = bindScopeRoute(client);
    await vi.waitFor(() => expect(harness.scopeLifecycle.subscriberAdded).toHaveBeenCalledOnce());
    leaveScope();
    const leaveDmm = bindDmmRoute(client);
    leaveDmm();
    const leaveFinalScope = bindScopeRoute(client);
    await vi.waitFor(() => {
      expect(runningDelta(harness.scopeLifecycle)).toBe(1);
      expect(runningDelta(harness.dmmLifecycle)).toBe(0);
    });
    const subscribersBeforeDrop = harness.scopeLifecycle.subscriberAdded.mock.calls.length;
    const stopsBeforeDrop = harness.scopeLifecycle.stop.mock.calls.length;
    harness.adapters.at(-1)?.terminate();
    await vi.waitFor(() => expect(harness.adapters.length).toBeGreaterThanOrEqual(2));
    await vi.waitFor(() => expect(harness.scopeLifecycle.stop.mock.calls.length).toBeGreaterThan(stopsBeforeDrop));
    await vi.waitFor(() => {
      expect(harness.scopeLifecycle.subscriberAdded.mock.calls.length).toBeGreaterThan(subscribersBeforeDrop);
      expect(runningDelta(harness.scopeLifecycle)).toBe(1);
      expect(runningDelta(harness.dmmLifecycle)).toBe(0);
    });
    leaveFinalScope();
  });
});
''', encoding='utf-8')

print('Stream A web integration harness updated')
