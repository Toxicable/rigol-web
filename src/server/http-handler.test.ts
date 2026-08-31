import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import { createHttpRequestHandler } from "./http-handler.js";

async function withBuiltWeb(
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "rigol-web-http-"));
  await writeFile(join(root, "index.html"), "<html>rigol app</html>");
  await writeFile(join(root, "asset.js"), "console.log('asset');");
  const server = createServer(createHttpRequestHandler(root));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;

  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error === undefined ? resolve() : reject(error));
    });
    await rm(root, { recursive: true, force: true });
  }
}

describe("createHttpRequestHandler", () => {
  it("serves index.html for direct DM858E route navigation", async () => {
    await withBuiltWeb(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/dm858e`);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("<html>rigol app</html>");
    });
  });

  it("does not turn missing static assets into SPA responses", async () => {
    await withBuiltWeb(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/missing.js`);
      expect(response.status).toBe(404);
      expect(await response.text()).toBe("not found\n");
    });
  });
});
