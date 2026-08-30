import { Buffer } from "node:buffer";
import { once } from "node:events";
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket as NodeWebSocket, type RawData } from "ws";

import { SupportedInstrument } from "../shared/instrument-types.js";
import {
  InstrumentRegistry,
  type InstrumentRuntime,
} from "../server/instruments/instrument-registry.js";
import {
  ServerDmmConnectionKind,
  ServerScopeConnectionKind,
  WebSocketGateway,
} from "../server/websocket/websocket-gateway.js";
import { bindDmmRoute } from "./dmm/dmm-route.js";
import { bindScopeRoute } from "./scope-route.js";
import {
  ScopeWebSocketClient,
  type WebSocketLike,
} from "./websocket-client.js";
import { WaveformController } from "./waveform/waveform-controller.js";

interface RuntimeSpy extends InstrumentRuntime {
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
}

function runtime(): RuntimeSpy {
  return {
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
  };
}

function binaryData(data: RawData): ArrayBuffer {
  const buffer = Array.isArray(data)
    ? Buffer.concat(data)
    : data instanceof ArrayBuffer
      ? Buffer.from(data)
      : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  ) as ArrayBuffer;
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
      this.onmessage?.({
        data: isBinary ? binaryData(data) : data.toString(),
      });
    });
    this.socket.on("close", (_code, reason) => {
      this.onclose?.({ reason: reason.toString() });
    });
    this.socket.on("error", () => this.onerror?.());
  }

  public get readyState(): number {
    return this.socket.readyState;
  }

  public send(data: string): void {
    this.socket.send(data);
  }

  public close(code?: number, reason?: string): void {
    this.socket.close(code, reason);
  }

  public terminate(): void {
    this.socket.terminate();
  }
}

interface Harness {
  httpServer: HttpServer;
  gateway: WebSocketGateway;
  scopeRuntime: RuntimeSpy;
  dmmRuntime: RuntimeSpy;
  clients: ScopeWebSocketClient[];
  adapters: NodeSocketAdapter[];
  createClient(): ScopeWebSocketClient;
}

let active: Harness | undefined;

beforeEach(() => {
  vi.stubGlobal("window", {
    setTimeout: (callback: () => void) => globalThis.setTimeout(callback, 0),
    clearTimeout: (handle: ReturnType<typeof setTimeout>) => globalThis.clearTimeout(handle),
    setInterval: (
      callback: () => void,
      delay?: number,
    ) => globalThis.setInterval(callback, delay),
    clearInterval: (handle: ReturnType<typeof setInterval>) => globalThis.clearInterval(handle),
  });
});

afterEach(async () => {
  if (active !== undefined) {
    for (const client of active.clients) {
      client.dispose();
    }
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
  const scopeRuntime = runtime();
  const dmmRuntime = runtime();
  const instruments = new InstrumentRegistry({
    dho804: {
      endpoint: { host: "scope.test", port: 5555 },
      runtime: scopeRuntime,
    },
    dm858e: {
      endpoint: { host: "dmm.test", port: 5556 },
      runtime: dmmRuntime,
    },
  });
  const gateway = new WebSocketGateway(
    httpServer,
    {
      kind: ServerScopeConnectionKind.Disconnected,
      reason: "scope inactive",
    },
    {
      instruments,
      initialDmmConnection: {
        kind: ServerDmmConnectionKind.Disconnected,
        reason: "DMM inactive",
      },
      waveformHandlers: {
        requestDeepCapture: async () => {
          throw new Error("unused waveform request");
        },
        requestViewport: async () => {
          throw new Error("unused waveform request");
        },
      },
      dmmHandlers: {
        setControl: async () => {
          throw new Error("unused DMM control");
        },
        executeRawScpi: async () => {
          throw new Error("unused DMM SCPI request");
        },
      },
    },
  );

  httpServer.listen(0, "127.0.0.1");
  await once(httpServer, "listening");
  const port = (httpServer.address() as AddressInfo).port;
  const clients: ScopeWebSocketClient[] = [];
  const adapters: NodeSocketAdapter[] = [];

  const harness: Harness = {
    httpServer,
    gateway,
    scopeRuntime,
    dmmRuntime,
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

function runningDelta(runtimeSpy: RuntimeSpy): number {
  return runtimeSpy.start.mock.calls.length - runtimeSpy.stop.mock.calls.length;
}

describe("route lifecycle through browser WebSocket and gateway", () => {
  it("switches scope to DMM to scope through the actual route binders", async () => {
    const harness = await createHarness();
    const client = harness.createClient();

    const leaveScope = bindScopeRoute(client);
    await vi.waitFor(() => expect(harness.scopeRuntime.start).toHaveBeenCalledOnce());

    leaveScope();
    const leaveDmm = bindDmmRoute(client);
    await vi.waitFor(() => {
      expect(harness.scopeRuntime.stop).toHaveBeenCalledOnce();
      expect(harness.dmmRuntime.start).toHaveBeenCalledOnce();
    });

    leaveDmm();
    const leaveScopeAgain = bindScopeRoute(client);
    await vi.waitFor(() => {
      expect(harness.dmmRuntime.stop).toHaveBeenCalledOnce();
      expect(harness.scopeRuntime.start).toHaveBeenCalledTimes(2);
      expect(runningDelta(harness.scopeRuntime)).toBe(1);
      expect(runningDelta(harness.dmmRuntime)).toBe(0);
    });

    leaveScopeAgain();
  });

  it("keeps one shared scope runtime alive until the last tab leaves", async () => {
    const harness = await createHarness();
    const first = harness.createClient();
    const second = harness.createClient();
    const leaveFirst = bindScopeRoute(first);
    const leaveSecond = bindScopeRoute(second);

    await vi.waitFor(() => expect(harness.scopeRuntime.start).toHaveBeenCalledOnce());

    leaveFirst();
    await new Promise((resolve) => globalThis.setTimeout(resolve, 20));
    expect(harness.scopeRuntime.stop).not.toHaveBeenCalled();

    leaveSecond();
    await vi.waitFor(() => expect(harness.scopeRuntime.stop).toHaveBeenCalledOnce());
  });

  it("keeps scope and DMM tabs independent and releases a runtime on socket close", async () => {
    const harness = await createHarness();
    const scopeClient = harness.createClient();
    const dmmClient = harness.createClient();
    bindScopeRoute(scopeClient);
    bindDmmRoute(dmmClient);

    await vi.waitFor(() => {
      expect(harness.scopeRuntime.start).toHaveBeenCalledOnce();
      expect(harness.dmmRuntime.start).toHaveBeenCalledOnce();
    });

    scopeClient.dispose();
    await vi.waitFor(() => expect(harness.scopeRuntime.stop).toHaveBeenCalledOnce());
    expect(harness.dmmRuntime.stop).not.toHaveBeenCalled();
    expect(runningDelta(harness.dmmRuntime)).toBe(1);

    dmmClient.dispose();
    await vi.waitFor(() => expect(harness.dmmRuntime.stop).toHaveBeenCalledOnce());
  });

  it("reconnects with only the final desired subscription after rapid switching", async () => {
    const harness = await createHarness();
    const client = harness.createClient();
    const leaveScope = bindScopeRoute(client);

    await vi.waitFor(() => expect(harness.scopeRuntime.start).toHaveBeenCalledOnce());

    leaveScope();
    const leaveDmm = bindDmmRoute(client);
    leaveDmm();
    const leaveFinalScope = bindScopeRoute(client);

    await vi.waitFor(() => {
      expect(runningDelta(harness.scopeRuntime)).toBe(1);
      expect(runningDelta(harness.dmmRuntime)).toBe(0);
    });

    const firstSocket = harness.adapters.at(-1);
    expect(firstSocket).toBeDefined();
    firstSocket?.terminate();

    await vi.waitFor(() => expect(harness.adapters.length).toBeGreaterThanOrEqual(2));
    await vi.waitFor(() => {
      expect(runningDelta(harness.scopeRuntime)).toBe(1);
      expect(runningDelta(harness.dmmRuntime)).toBe(0);
    });

    leaveFinalScope();
  });
});
