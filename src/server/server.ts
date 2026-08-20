import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";

import { ScopeRuntime } from "./scope-runtime.js";
import {
  ServerScopeConnectionKind,
  WebSocketGateway,
  type ServerScopeConnection,
} from "./websocket/websocket-gateway.js";

const HTTP_PORT_DEFAULT = 3_000;
const WEB_ROOT = resolve(process.cwd(), "dist/web");

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

function contentType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".html": return "text/html; charset=utf-8";
    case ".js": return "text/javascript; charset=utf-8";
    case ".css": return "text/css; charset=utf-8";
    case ".json": return "application/json; charset=utf-8";
    case ".svg": return "image/svg+xml";
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".webp": return "image/webp";
    case ".ico": return "image/x-icon";
    case ".woff2": return "font/woff2";
    case ".map": return "application/json; charset=utf-8";
    default: return "application/octet-stream";
  }
}

function sendText(response: ServerResponse, status: number, text: string): void {
  response.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  response.end(text);
}

async function serveBuiltWeb(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    sendText(response, 404, "not found\n");
    return;
  }

  let pathname: string;
  try {
    const url = new URL(request.url ?? "/", "http://localhost");
    pathname = decodeURIComponent(url.pathname);
  } catch {
    sendText(response, 400, "bad request\n");
    return;
  }

  const relativePath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const filePath = resolve(WEB_ROOT, relativePath);
  const rootPrefix = WEB_ROOT.endsWith(sep) ? WEB_ROOT : `${WEB_ROOT}${sep}`;
  if (filePath !== WEB_ROOT && !filePath.startsWith(rootPrefix)) {
    sendText(response, 404, "not found\n");
    return;
  }

  try {
    const body = await readFile(filePath);
    response.writeHead(200, {
      "content-type": contentType(filePath),
      "content-length": String(body.byteLength),
    });
    if (request.method === "HEAD") {
      response.end();
      return;
    }
    response.end(body);
  } catch (error) {
    const code = error instanceof Error && "code" in error
      ? String((error as NodeJS.ErrnoException).code)
      : "";
    if (code === "ENOENT" || code === "EISDIR" || code === "ENOTDIR") {
      sendText(response, 404, "not found\n");
      return;
    }
    console.error("Failed to serve built web asset", error);
    sendText(response, 500, "internal server error\n");
  }
}

const httpPort = readHttpPort();
const rigolHost = readRigolHost();
const rigolPort = readRigolPort();

const server = createServer((request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    response.end("ok\n");
    return;
  }

  void serveBuiltWeb(request, response);
});

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
