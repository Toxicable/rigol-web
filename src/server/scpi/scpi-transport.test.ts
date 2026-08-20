import { createServer, type Server } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import {
  ScpiResponseTypeError,
  ScpiTransport,
  ScpiTransportError,
} from "./scpi-transport.js";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) => new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );
});

async function peer(
  onCommand: (
    command: string,
    write: (data: Uint8Array | string) => void,
    close: () => void,
  ) => void,
) {
  const server = createServer((socket) => {
    let buffered = "";
    socket.on("data", (chunk) => {
      buffered += chunk.toString("utf8");
      for (;;) {
        const newline = buffered.indexOf("\n");
        if (newline < 0) return;
        const command = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        onCommand(command, (data) => socket.write(data), () => socket.destroy());
      }
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("bad test address");
  return address.port;
}

describe("ScpiTransport", () => {
  it("frames text across arbitrary TCP chunks", async () => {
    const port = await peer((_command, write) => {
      write("HEL");
      queueMicrotask(() => write("LO\r\n"));
    });
    const transport = new ScpiTransport(1000);
    await transport.connect("127.0.0.1", port);
    await expect(transport.queryText("TEXT?")).resolves.toBe("HELLO");
    transport.disconnect();
  });

  it("frames a split binary block and returns payload only", async () => {
    const port = await peer((_command, write) => {
      write("#");
      queueMicrotask(() => write(Uint8Array.from([0x31, 0x34, 1, 2])));
      queueMicrotask(() => write(Uint8Array.from([3, 4, 0x0a])));
    });
    const transport = new ScpiTransport(1000);
    await transport.connect("127.0.0.1", port);
    await expect(transport.queryBinary("BIN?")).resolves.toEqual(Uint8Array.from([1, 2, 3, 4]));
    transport.disconnect();
  });

  it("consumes a binary type mismatch before the next query", async () => {
    const port = await peer((command, write) => {
      if (command === "BIN?") write(Uint8Array.from([0x23, 0x31, 0x32, 9, 8, 0x0a]));
      else write("OK\n");
    });
    const transport = new ScpiTransport(1000);
    await transport.connect("127.0.0.1", port);
    await expect(transport.queryText("BIN?")).rejects.toBeInstanceOf(ScpiResponseTypeError);
    await expect(transport.queryText("NEXT?")).resolves.toBe("OK");
    transport.disconnect();
  });

  it("consumes a text type mismatch before the next query", async () => {
    const port = await peer((command, write) => write(command === "TEXT?" ? "NOPE\n" : "OK\n"));
    const transport = new ScpiTransport(1000);
    await transport.connect("127.0.0.1", port);
    await expect(transport.queryBinary("TEXT?")).rejects.toBeInstanceOf(ScpiResponseTypeError);
    await expect(transport.queryText("NEXT?")).resolves.toBe("OK");
    transport.disconnect();
  });

  it("invalidates the transport on malformed binary framing", async () => {
    const port = await peer((_command, write) => write("#0bad\n"));
    const transport = new ScpiTransport(1000);
    await transport.connect("127.0.0.1", port);
    await expect(transport.query("BAD?")).rejects.toBeInstanceOf(ScpiTransportError);
    expect(transport.isUsable()).toBe(false);
  });

  it("rejects a text query when the socket closes mid-response", async () => {
    const port = await peer((_command, write, close) => {
      write("PARTIAL");
      queueMicrotask(close);
    });
    const transport = new ScpiTransport(1000);
    await transport.connect("127.0.0.1", port);
    await expect(transport.queryText("TEXT?")).rejects.toBeInstanceOf(ScpiTransportError);
    expect(transport.isUsable()).toBe(false);
  });

  it("rejects a binary query when the socket closes before the declared payload completes", async () => {
    const port = await peer((_command, write, close) => {
      write(Uint8Array.from([0x23, 0x31, 0x34, 1, 2]));
      queueMicrotask(close);
    });
    const transport = new ScpiTransport(1000);
    await transport.connect("127.0.0.1", port);
    await expect(transport.queryBinary("BIN?")).rejects.toBeInstanceOf(ScpiTransportError);
    expect(transport.isUsable()).toBe(false);
  });
});
