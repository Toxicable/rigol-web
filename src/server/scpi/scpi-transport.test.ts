import { createServer, type Server } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import {
  ScpiResponseTypeError,
  ScpiTransport,
  ScpiTransportError,
} from "./scpi-transport.js";
import { Dho804Emulator } from "./dho804-emulator.js";

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

  it("replays the DHO804 999-point waveform after a settled timebase change", async () => {
    const payload = Uint8Array.from({ length: 999 }, (_, index) => index & 0xff);
    let stoppedAt = 0;
    const port = await peer((command, write) => {
      if (command === ":STOP") {
        stoppedAt = Date.now();
        return;
      }
      if (command === ":TIMebase:MAIN:SCALe 0.00002") {
        expect(Date.now() - stoppedAt).toBeGreaterThanOrEqual(45);
        return;
      }
      if (command === ":TIMebase:MAIN:SCALe?") {
        write("2.000000E-5\n");
        return;
      }
      if (command === ":RUN") return;
      if (command === ":WAVeform:PREamble?") {
        write("0,0,999,1,2.000000E-7,0,0,0.5,10,0\n");
        return;
      }
      if (command === ":WAVeform:DATA?") {
        const block = Buffer.concat([
          Buffer.from("#9000000999"),
          Buffer.from(payload),
          Buffer.from("\n"),
        ]);
        write(block.subarray(0, 512));
        setTimeout(() => write(block.subarray(512)), 60);
      }
    });
    const transport = new ScpiTransport(1000);
    await transport.connect("127.0.0.1", port);
    await transport.command(":STOP");
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    await transport.command(":TIMebase:MAIN:SCALe 0.00002");
    await expect(transport.queryText(":TIMebase:MAIN:SCALe?")).resolves.toBe("2.000000E-5");
    await transport.command(":RUN");
    await expect(transport.queryText(":WAVeform:PREamble?")).resolves.toContain(",999,");
    await expect(transport.queryBinary(":WAVeform:DATA?")).resolves.toHaveLength(999);
    transport.disconnect();
  });

  it("emulates the DHO804 early-read failure and settled recovery", async () => {
    const emulator = new Dho804Emulator({ responseChunkDelayMs: 10, earlyDataWindowMs: 50 });
    const port = await emulator.listen();
    const transport = new ScpiTransport(1000);
    await transport.connect("127.0.0.1", port);

    await transport.command(":STOP");
    await expect(
      transport.queryBinary(":WAVeform:DATA?", { acceptPartialBinary: true }),
    ).resolves.toHaveLength(501);
    expect(transport.isUsable()).toBe(true);
    await expect(transport.queryText(":TIMebase:MAIN:SCALe?")).resolves.toBe("1.000000e-5");
    await transport.command(":STOP");
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    await transport.command(":TIMebase:MAIN:SCALe 0.00002");
    await transport.command(":RUN");
    await expect(transport.queryText(":WAVeform:PREamble?")).resolves.toContain(",999,");
    await expect(transport.queryBinary(":WAVeform:DATA?")).resolves.toHaveLength(999);

    transport.disconnect();
    await emulator.close();
  });

  it("discards a partial Main waveform without killing the SCPI socket", async () => {
    const emulator = new Dho804Emulator({ responseChunkDelayMs: 10, earlyDataWindowMs: 50 });
    const port = await emulator.listen();
    const transport = new ScpiTransport(1000);
    await transport.connect("127.0.0.1", port);

    await transport.command(":STOP");
    await expect(transport.queryBinary(":WAVeform:DATA?")).rejects.toThrow(
      "Discarded incomplete live waveform frame",
    );
    expect(transport.isUsable()).toBe(true);
    await expect(transport.queryText(":TIMebase:MAIN:SCALe?")).resolves.toBe("1.000000e-5");

    transport.disconnect();
    await emulator.close();
  });

  it("accepts a complete binary block without a trailing line terminator", async () => {
    const port = await peer((_command, write) => {
      write(Uint8Array.from([0x23, 0x31, 0x34, 1, 2, 3, 4]));
    });
    const transport = new ScpiTransport(1000);
    await transport.connect("127.0.0.1", port);
    await expect(transport.queryBinary("BIN?")).resolves.toEqual(Uint8Array.from([1, 2, 3, 4]));
    transport.disconnect();
  });

  it("frames multiple binary query responses from one compound program message", async () => {
    const port = await peer((command, write) => {
      expect(command).toBe("SRC1;DATA?;SRC2;DATA?");
      write(Uint8Array.from([0x23, 0x31, 0x32, 1, 2, 0x3b, 0x23]));
      queueMicrotask(() => write(Uint8Array.from([0x31, 0x32, 3, 4, 0x0a])));
    });
    const transport = new ScpiTransport(1000);
    await transport.connect("127.0.0.1", port);
    await expect(
      transport.queryBinaryBlocks("SRC1;DATA?;SRC2;DATA?", 2),
    ).resolves.toEqual([
      Uint8Array.from([1, 2]),
      Uint8Array.from([3, 4]),
    ]);
    transport.disconnect();
  });

  it("accepts line-separated compound binary responses", async () => {
    const port = await peer((_command, write) => {
      write(Uint8Array.from([
        0x23, 0x31, 0x32, 1, 2, 0x0a,
        0x23, 0x31, 0x32, 3, 4, 0x0a,
      ]));
    });
    const transport = new ScpiTransport(1000);
    await transport.connect("127.0.0.1", port);
    await expect(transport.queryBinaryBlocks("MULTI?", 2)).resolves.toEqual([
      Uint8Array.from([1, 2]),
      Uint8Array.from([3, 4]),
    ]);
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

  it("includes received and buffered byte counts in timeout errors", async () => {
    const port = await peer((_command, write) => {
      write(Uint8Array.from([0x23, 0x31, 0x34, 1, 2]));
    });
    const transport = new ScpiTransport(25);
    await transport.connect("127.0.0.1", port);
    await expect(transport.queryBinary("BIN?")).rejects.toThrow(
      /received 5 bytes, 5 buffered/,
    );
    expect(transport.isUsable()).toBe(false);
  });
});
