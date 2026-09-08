import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";

const DEFAULT_WEB_ROOT = resolve(process.cwd(), "dist/web");
const SPA_ROUTES = new Set(["/", "/dm858e", "/dm858e/"]);

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

async function serveBuiltWeb(
  request: IncomingMessage,
  response: ServerResponse,
  webRoot: string,
): Promise<void> {
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

  const relativePath = SPA_ROUTES.has(pathname)
    ? "index.html"
    : pathname.replace(/^\/+/, "");
  const filePath = resolve(webRoot, relativePath);
  const rootPrefix = webRoot.endsWith(sep) ? webRoot : `${webRoot}${sep}`;
  if (filePath !== webRoot && !filePath.startsWith(rootPrefix)) {
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

export function createHttpRequestHandler(
  webRoot = DEFAULT_WEB_ROOT,
): (request: IncomingMessage, response: ServerResponse) => void {
  const absoluteWebRoot = resolve(webRoot);

  return (request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      response.end("ok\n");
      return;
    }

    void serveBuiltWeb(request, response, absoluteWebRoot);
  };
}
