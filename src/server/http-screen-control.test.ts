import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { describe, expect, it, vi } from "vitest";

import { createHttpRequestHandler, type HttpControlActions } from "./http-handler.js";

async function withServer(
  controlActions: HttpControlActions,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = createServer(createHttpRequestHandler(undefined, controlActions));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
    await once(server, "close");
  }
}

describe("scope display HTTP control", () => {
  it("runs the injected DHO804 screen-off action", async () => {
    const screenOffScope = vi.fn(async () => undefined);
    const screenOnScope = vi.fn(async () => undefined);

    await withServer({ screenOffScope, screenOnScope }, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/scope/screen-off`, { method: "POST" });
      expect(response.status).toBe(204);
    });

    expect(screenOffScope).toHaveBeenCalledTimes(1);
    expect(screenOnScope).not.toHaveBeenCalled();
  });

  it("runs the injected DHO804 screen-on action", async () => {
    const screenOffScope = vi.fn(async () => undefined);
    const screenOnScope = vi.fn(async () => undefined);

    await withServer({ screenOffScope, screenOnScope }, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/scope/screen-on`, { method: "POST" });
      expect(response.status).toBe(204);
    });

    expect(screenOnScope).toHaveBeenCalledTimes(1);
    expect(screenOffScope).not.toHaveBeenCalled();
  });

  it("surfaces ADB display failures to the browser", async () => {
    await withServer(
      {
        screenOffScope: async () => undefined,
        screenOnScope: async () => {
          throw new Error("ADB unavailable");
        },
      },
      async (baseUrl) => {
        const response = await fetch(`${baseUrl}/api/scope/screen-on`, { method: "POST" });
        expect(response.status).toBe(502);
        expect(await response.text()).toContain("ADB unavailable");
      },
    );
  });
});
