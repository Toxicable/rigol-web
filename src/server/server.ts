import { createServer } from "node:http";

import { AcquisitionService } from "./acquisition/acquisition-service.js";
import { DmmService } from "./dmm/dmm-service.js";
import { createHttpRequestHandler } from "./http-handler.js";
import { InstrumentRegistry } from "./instruments/instrument-registry.js";
import { ScopeService } from "./scope/scope-service.js";
import { AcquisitionWebSocketAdapter } from "./websocket/acquisition-websocket-adapter.js";
import { DmmWebSocketAdapter } from "./websocket/dmm-websocket-adapter.js";
import { ScopeWebSocketAdapter } from "./websocket/scope-websocket-adapter.js";
import { WebSocketGateway } from "./websocket/websocket-gateway.js";

const HTTP_PORT_DEFAULT = 3_000;
const SCOPE_ADB_PORT_DEFAULT = 55_555;

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

function readScopeAdbPort(): number {
  const raw = process.env.RIGOL_SCOPE_ADB_PORT?.trim();
  if (raw === undefined || raw.length === 0) {
    return SCOPE_ADB_PORT_DEFAULT;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error("RIGOL_SCOPE_ADB_PORT must be an integer from 1 through 65535");
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

const scopeService = new ScopeService({
  ...scopeEndpoint,
  adbPort: readScopeAdbPort(),
});
const dmmService = new DmmService(dmmEndpoint);
const acquisitionService = new AcquisitionService();

const instruments = new InstrumentRegistry({
  dho804: scopeService.runtime,
  dm858e: dmmService.runtime,
});

const server = createServer(createHttpRequestHandler());
const acquisitionAdapter = new AcquisitionWebSocketAdapter(acquisitionService);
const scopeAdapter = new ScopeWebSocketAdapter(scopeService);
const dmmAdapter = new DmmWebSocketAdapter(dmmService);
const gateway = new WebSocketGateway(server, {
  acquisitionAdapter,
  scopeAdapter,
  dmmAdapter,
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
  scopeService.close();
  acquisitionService.close();

  try {
    await gateway.close();
    await instruments.stopAll();
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

await instruments.startAll();
server.listen(httpPort, () => {
  console.log(`Rigol Web server listening on http://localhost:${httpPort}`);
});
