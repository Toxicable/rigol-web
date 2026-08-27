import { createServer } from "node:http";

import { createHttpRequestHandler } from "./http-handler.js";
import { InstrumentRegistry } from "./instruments/instrument-registry.js";
import { ScopeRuntime } from "./scope-runtime.js";
import {
  ServerDmmConnectionKind,
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

function readInstrumentHost(name: "RIGOL_SCOPE_HOST" | "RIGOL_DMM_HOST"): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

function readInstrumentPort(name: "RIGOL_SCOPE_PORT" | "RIGOL_DMM_PORT"): number {
  const raw = process.env[name];
  const value = Number(raw);
  if (raw === undefined || raw.trim().length === 0 || !Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`${name} must be an integer from 1 through 65535`);
  }
  return value;
}

const httpPort = readHttpPort();
const scopeEndpoint = {
  host: readInstrumentHost("RIGOL_SCOPE_HOST"),
  port: readInstrumentPort("RIGOL_SCOPE_PORT"),
};
const dmmEndpoint = {
  host: readInstrumentHost("RIGOL_DMM_HOST"),
  port: readInstrumentPort("RIGOL_DMM_PORT"),
};

const server = createServer(createHttpRequestHandler());

const initialScopeConnection: ServerScopeConnection = {
  kind: ServerScopeConnectionKind.Disconnected,
  reason: "Scope runtime inactive",
};

let gateway!: WebSocketGateway;
const scopeRuntime = new ScopeRuntime({
  ...scopeEndpoint,
  publishConnection: (connection) => gateway.setScopeConnection(connection),
  publishWaveform: (frame) => gateway.broadcastWaveform(frame),
});

const dmmRuntime = {
  start: () => undefined,
  stop: () => undefined,
};

const instruments = new InstrumentRegistry({
  dho804: {
    endpoint: scopeEndpoint,
    runtime: scopeRuntime,
  },
  dm858e: {
    endpoint: dmmEndpoint,
    runtime: dmmRuntime,
  },
});

gateway = new WebSocketGateway(server, initialScopeConnection, {
  instruments,
  initialDmmConnection: {
    kind: ServerDmmConnectionKind.Disconnected,
    reason: "DM858E backend not implemented",
  },
  waveformHandlers: {
    requestDeepCapture: (requestId) => scopeRuntime.requestDeepCapture(requestId),
    requestViewport: (request) => scopeRuntime.requestViewport(request),
  },
  dmmHandlers: {
    setControl: async () => {
      throw new Error("DM858E backend not implemented");
    },
    executeRawScpi: async () => {
      throw new Error("DM858E backend not implemented");
    },
  },
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
    await instruments.stopAll();
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
});
