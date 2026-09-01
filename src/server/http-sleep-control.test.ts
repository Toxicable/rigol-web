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

describe("scope power HTTP control", () => {
  it("runs the injected DHO804 sleep action", async () => {
    const sleepScope = vi.fn(async () => undefined);
    const wakeScope = vi.fn(async () => undefined);

    await withServer({ sleepScope, wakeScope }, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/scope/sleep`, { method: "POST" });
      expect(response.status).toBe(204);
    });

    expect(sleepScope).toHaveBeenCalledTimes(1);
    expect(wakeScope).not.toHaveBeenCalled();
  });

  it("runs the injected DHO804 wake action", async () => {
    const sleepScope = vi.fn(async () => undefined);
    const wakeScope = vi.fn(async () => undefined);

    await withServer({ sleepScope, wakeScope }, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/scope/wake`, { method: "POST" });
      expect(response.status).toBe(204);
    });

    expect(wakeScope).toHaveBeenCalledTimes(1);
    expect(sleepScope).not.toHaveBeenCalled();
  });

  it("surfaces ADB power failures to the browser", async () => {
    await withServer(
      {
        sleepScope: async () => undefined,
        wakeScope: async () => {
          throw new Error("ADB unavailable");
        },
      },
      async (baseUrl) => {
        const response = await fetch(`${baseUrl}/api/scope/wake`, { method: "POST" });
        expect(response.status).toBe(502);
        expect(await response.text()).toContain("ADB unavailable");
      },
    );
  });
});
