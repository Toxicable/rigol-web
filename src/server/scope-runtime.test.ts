import { createServer as createHttpServer, request } from "node:http";
import {
  createServer as createNetServer,
  type AddressInfo,
  type Server as NetServer,
  type Socket,
} from "node:net";

import { describe, expect, it } from "vitest";

import { createHttpRequestHandler } from "./http-handler.js";
import { ScopeRuntime } from "./scope-runtime.js";
import {
  ServerScopeConnectionKind,
  type ServerScopeConnection,
} from "./websocket/websocket-gateway.js";

type ConnectedScopeConnection = Extract<
  ServerScopeConnection,
  { kind: ServerScopeConnectionKind.Connected }
>;

interface FakeConnection {
  index: number;
  socket: Socket;
  commands: string[];
  buffer: string;
}

async function listen(server: NetServer): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("error", onError);
      reject(error);
    };
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Expected local TCP server address");
  }
  return (address as AddressInfo).port;
}

async function closeServer(server: NetServer): Promise<void> {
  if (!server.listening) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error !== undefined) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function unusedPort(): Promise<number> {
  const server = createNetServer();
  const port = await listen(server);
  await closeServer(server);
  return port;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor<T>(read: () => T | undefined, timeoutMs = 3_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) {
      return value;
    }
    await delay(10);
  }
  throw new Error(`Timed out after ${timeoutMs} ms`);
}

async function getText(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const outgoing = request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: "GET",
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    outgoing.on("error", reject);
    outgoing.end();
  });
}

function responseFor(command: string, connectionIndex: number): string | undefined {
  if (command === "*IDN?") {
    return `RIGOL TECHNOLOGIES,DHO804,FAKE-${connectionIndex},00.01`;
  }
  if (/^:CHANnel[1-4]:DISPlay\?$/.test(command)) return "0";
  if (/^:CHANnel[1-4]:COUPling\?$/.test(command)) return "DC";
  if (/^:CHANnel[1-4]:UNITs\?$/.test(command)) return "VOLT";
  if (/^:CHANnel[1-4]:SCALe\?$/.test(command)) return "1";
  if (/^:CHANnel[1-4]:OFFSet\?$/.test(command)) return "0";
  if (/^:CHANnel[1-4]:PROBe\?$/.test(command)) return "1";
  switch (command) {
    case ":TIMebase:XY:ENABle?": return "0";
    case ":TIMebase:MODE?": return "MAIN";
    case ":TIMebase:MAIN:SCALe?": return "0.001";
    case ":TIMebase:MAIN:OFFSet?": return "0";
    case ":ACQuire:TYPE?": return "NORM";
    case ":ACQuire:AVERages?": return "2";
    case ":ACQuire:MDEPth?": return "1000";
    case ":ACQuire:SRATe?": return "1000000";
    case ":TRIGger:STATus?": return "STOP";
    case ":TRIGger:MODE?": return "EDGE";
    case ":TRIGger:SWEep?": return "AUTO";
    case ":TRIGger:EDGE:SOURce?": return "CHAN1";
    case ":TRIGger:EDGE:SLOPe?": return "POS";
    case ":TRIGger:EDGE:LEVel?": return "0";
    case ":TRIGger:COUPling?": return "DC";
    default: return undefined;
  }
}

class FakeDho804Server {
  public readonly server = createNetServer((socket) => this.accept(socket));
  public readonly connections: FakeConnection[] = [];

  public async start(): Promise<number> {
    return listen(this.server);
  }

  public disconnect(index: number): void {
    this.connections[index - 1]?.socket.destroy();
  }

  public async stop(): Promise<void> {
    for (const connection of this.connections) {
      connection.socket.destroy();
    }
    await closeServer(this.server);
  }

  private accept(socket: Socket): void {
    const connection: FakeConnection = {
      index: this.connections.length + 1,
      socket,
      commands: [],
      buffer: "",
    };
    this.connections.push(connection);

    socket.on("data", (chunk) => {
      connection.buffer += chunk.toString("utf8");
      while (true) {
        const newline = connection.buffer.indexOf("\n");
        if (newline < 0) {
          break;
        }
        const command = connection.buffer.slice(0, newline).replace(/\r$/, "");
        connection.buffer = connection.buffer.slice(newline + 1);
        connection.commands.push(command);

        const response = responseFor(command, connection.index);
        if (response !== undefined) {
          socket.write(`${response}\n`);
        } else if (command.includes("?")) {
          socket.write("0\n");
        }
      }
    });
  }
}

describe("ScopeRuntime integration", () => {
  it("keeps /health available while scope startup is unavailable", async () => {
    const scopePort = await unusedPort();
    const httpServer = createHttpServer(createHttpRequestHandler());
    const httpPort = await listen(httpServer);
    const runtime = new ScopeRuntime({
      host: "127.0.0.1",
      port: scopePort,
      reconnectDelayMs: 20,
      connectTimeoutMs: 100,
      publishConnection: () => {},
      publishWaveform: () => {},
    });

    try {
      runtime.start();
      await delay(25);
      await expect(getText(httpPort, "/health")).resolves.toEqual({
        status: 200,
        body: "ok\n",
      });
    } finally {
      await runtime.stop();
      await closeServer(httpServer);
    }
  });

  it("cancels a blocked initial SCPI query during shutdown", async () => {
    let acceptedResolve!: () => void;
    const accepted = new Promise<void>((resolve) => {
      acceptedResolve = resolve;
    });
    const sockets: Socket[] = [];
    const blockingServer = createNetServer((socket) => {
      sockets.push(socket);
      acceptedResolve();
    });
    const port = await listen(blockingServer);
    const runtime = new ScopeRuntime({
      host: "127.0.0.1",
      port,
      reconnectDelayMs: 20,
      connectTimeoutMs: 10_000,
      publishConnection: () => {},
      publishWaveform: () => {},
    });

    try {
      runtime.start();
      await accepted;
      await delay(20);
      const startedAt = Date.now();
      await runtime.stop();
      expect(Date.now() - startedAt).toBeLessThan(500);
    } finally {
      for (const socket of sockets) socket.destroy();
      await runtime.stop();
      await closeServer(blockingServer);
    }
  });

  it("reconnects with a fresh session and never reuses a stale controller", async () => {
    const fake = new FakeDho804Server();
    const port = await fake.start();
    const connected: ConnectedScopeConnection[] = [];
    const runtime = new ScopeRuntime({
      host: "127.0.0.1",
      port,
      reconnectDelayMs: 20,
      connectTimeoutMs: 500,
      publishConnection: (connection) => {
        if (connection.kind === ServerScopeConnectionKind.Connected) {
          connected.push(connection);
        }
      },
      publishWaveform: () => {},
    });

    try {
      runtime.start();
      const first = await waitFor(() => connected[0]);
      expect(first.info.serialNumber).toBe("FAKE-1");

      fake.disconnect(1);
      const second = await waitFor(() => connected[1], 2_500);
      expect(second.info.serialNumber).toBe("FAKE-2");
      expect(second.controller).not.toBe(first.controller);

      await expect(first.controller.executeRawScpi(":SYSTem:ERRor?")).rejects.toThrow();
      await delay(20);
      expect(fake.connections[1]?.commands).not.toContain(":SYSTem:ERRor?");
    } finally {
      await runtime.stop();
      await fake.stop();
    }
  });
});
