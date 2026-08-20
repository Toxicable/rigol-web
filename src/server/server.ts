import { createServer } from "node:http";

import { createHttpRequestHandler } from "./http-handler.js";
import { ScopeRuntime } from "./scope-runtime.js";
import {
  ServerScopeConnectionKind,
  WebSocketGateway,
  type ServerScopeConnection,
} from "./websocket/websocket-gateway.js";

const HTTP_PORT_DEFAULT = 3_000;

function readHttpPort(): number {
  const value = Number(process.env.PORT ?? HTTP_PORT_DEFAULT);
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`Invalid PORT: ${process.env.PORT ?? ""}`);
  }
  return value;
}

function readRigolHost(): string {
  const value = process.env.RIGOL_HOST?.trim();
  if (value === undefined || value.length === 0) {
    throw new Error("RIGOL_HOST must be a non-empty string");
  }
  return value;
}

function readRigolPort(): number {
  const raw = process.env.RIGOL_PORT;
  const value = Number(raw);
  if (raw === undefined || raw.trim().length === 0 || !Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error("RIGOL_PORT must be an integer from 1 through 65535");
  }
  return value;
}

const httpPort = readHttpPort();
const rigolHost = readRigolHost();
const rigolPort = readRigolPort();

const server = createServer(createHttpRequestHandler());

const initialConnection: ServerScopeConnection = {
  kind: ServerScopeConnectionKind.Disconnected,
  reason: "Scope connection pending",
};

let gateway!: WebSocketGateway;
const runtime = new ScopeRuntime({
  host: rigolHost,
  port: rigolPort,
  publishConnection: (connection) => gateway.setScopeConnection(connection),
  publishWaveform: (frame) => gateway.broadcastWaveform(frame),
});

gateway = new WebSocketGateway(server, initialConnection, {
  requestDeepCapture: (requestId) => runtime.requestDeepCapture(requestId),
  requestViewport: (request) => runtime.requestViewport(request),
});

let shuttingDown = false;

async function closeHttpServer(): Promise<void> {
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => {
      if (error !== undefined) {
        rejectClose(error);
        return;
      }
      resolveClose();
    });
  });
}

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  console.log(`Rigol Web shutting down on ${signal}`);

  try {
    await runtime.stop();
    await gateway.close();
    await closeHttpServer();
  } catch (error) {
    console.error("Rigol Web shutdown failed", error);
    process.exitCode = 1;
  }
}

process.once("SIGINT", () => {
  void shutdown("SIGINT");
});
process.once("SIGTERM", () => {
  void shutdown("SIGTERM");
});

server.once("error", (error) => {
  console.error("Rigol Web server failed", error);
  process.exitCode = 1;
});

server.listen(httpPort, () => {
  console.log(`Rigol Web server listening on http://localhost:${httpPort}`);
  runtime.start();
});
