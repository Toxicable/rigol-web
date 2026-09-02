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

function controls(overrides: Partial<HttpControlActions> = {}): HttpControlActions {
  return {
    screenOffScope: async () => undefined,
    screenOnScope: async () => undefined,
    sleepScope: async () => undefined,
    wakeScope: async () => undefined,
    ...overrides,
  };
}

describe("scope display HTTP control", () => {
  it("runs the injected DHO804 screen-off action", async () => {
    const screenOffScope = vi.fn(async () => undefined);
    const screenOnScope = vi.fn(async () => undefined);

    await withServer(controls({ screenOffScope, screenOnScope }), async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/scope/screen-off`, { method: "POST" });
      expect(response.status).toBe(204);
    });

    expect(screenOffScope).toHaveBeenCalledTimes(1);
    expect(screenOnScope).not.toHaveBeenCalled();
  });

  it("runs the injected DHO804 screen-on action", async () => {
    const screenOffScope = vi.fn(async () => undefined);
    const screenOnScope = vi.fn(async () => undefined);

    await withServer(controls({ screenOffScope, screenOnScope }), async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/scope/screen-on`, { method: "POST" });
      expect(response.status).toBe(204);
    });

    expect(screenOnScope).toHaveBeenCalledTimes(1);
    expect(screenOffScope).not.toHaveBeenCalled();
  });

  it("runs the injected DHO804 native Sleep action", async () => {
    const sleepScope = vi.fn(async () => undefined);
    const wakeScope = vi.fn(async () => undefined);

    await withServer(controls({ sleepScope, wakeScope }), async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/scope/sleep`, { method: "POST" });
      expect(response.status).toBe(204);
    });

    expect(sleepScope).toHaveBeenCalledTimes(1);
    expect(wakeScope).not.toHaveBeenCalled();
  });

  it("runs the injected DHO804 wake action", async () => {
    const sleepScope = vi.fn(async () => undefined);
    const wakeScope = vi.fn(async () => undefined);

    await withServer(controls({ sleepScope, wakeScope }), async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/scope/wake`, { method: "POST" });
      expect(response.status).toBe(204);
    });

    expect(wakeScope).toHaveBeenCalledTimes(1);
    expect(sleepScope).not.toHaveBeenCalled();
  });

  it("surfaces ADB display failures to the browser", async () => {
    await withServer(
      controls({
        wakeScope: async () => {
          throw new Error("ADB unavailable");
        },
      }),
      async (baseUrl) => {
        const response = await fetch(`${baseUrl}/api/scope/wake`, { method: "POST" });
        expect(response.status).toBe(502);
        expect(await response.text()).toContain("ADB unavailable");
      },
    );
  });
});
