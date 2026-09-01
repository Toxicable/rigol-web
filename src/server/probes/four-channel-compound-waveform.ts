import { Socket } from "node:net";

const POINT_COUNT = 999;
const ROUNDS = 10;
const RESPONSE_TIMEOUT_MS = 2_000;
const CHANNELS = [1, 2, 3, 4] as const;

interface TimingSummary {
  count: number;
  medianMs: number;
  meanMs: number;
  minMs: number;
  maxMs: number;
}

interface Parsed<T> {
  value: T;
  consumed: number;
}

type Parser<T> = (buffer: Buffer) => Parsed<T> | null;

interface PendingRead<T> {
  command: string;
  parser: Parser<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

function requireHost(): string {
  const host = process.env.RIGOL_SCOPE_HOST?.trim() ?? "";
  if (host.length === 0) {
    throw new Error("RIGOL_SCOPE_HOST must be set");
  }
  return host;
}

function requirePort(): number {
  const raw = process.env.RIGOL_SCOPE_PORT?.trim() ?? "";
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("RIGOL_SCOPE_PORT must be an integer from 1 through 65535");
  }
  return port;
}

function summarize(values: number[]): TimingSummary {
  if (values.length === 0) {
    throw new Error("Cannot summarize an empty timing set");
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle];
  if (upper === undefined) {
    throw new Error("Timing summary has no median sample");
  }
  const lower = sorted[middle - 1] ?? upper;
  return {
    count: values.length,
    medianMs: sorted.length % 2 === 0 ? (lower + upper) / 2 : upper,
    meanMs: values.reduce((sum, value) => sum + value, 0) / values.length,
    minMs: sorted[0] ?? upper,
    maxMs: sorted[sorted.length - 1] ?? upper,
  };
}

function parseText(buffer: Buffer): Parsed<string> | null {
  const newline = buffer.indexOf(0x0a);
  if (newline < 0) {
    return null;
  }
  let end = newline;
  if (end > 0 && buffer[end - 1] === 0x0d) {
    end -= 1;
  }
  return {
    value: buffer.subarray(0, end).toString("utf8"),
    consumed: newline + 1,
  };
}

function parseBlockAt(buffer: Buffer, start: number): { payload: Uint8Array; end: number } | null {
  if (buffer.length <= start) {
    return null;
  }
  if (buffer[start] !== 0x23) {
    throw new Error(`Expected IEEE488.2 block at byte ${start}`);
  }
  if (buffer.length <= start + 1) {
    return null;
  }
  const digitByte = buffer[start + 1];
  if (digitByte === undefined || digitByte < 0x31 || digitByte > 0x39) {
    throw new Error(`Malformed IEEE488.2 block digit count at byte ${start + 1}`);
  }
  const digitCount = digitByte - 0x30;
  const lengthStart = start + 2;
  const payloadStart = lengthStart + digitCount;
  if (buffer.length < payloadStart) {
    return null;
  }
  const lengthText = buffer.subarray(lengthStart, payloadStart).toString("ascii");
  if (!/^\d+$/.test(lengthText)) {
    throw new Error(`Malformed IEEE488.2 payload length at byte ${lengthStart}`);
  }
  const payloadLength = Number(lengthText);
  if (!Number.isSafeInteger(payloadLength) || payloadLength < 0) {
    throw new Error("Invalid IEEE488.2 payload length");
  }
  const end = payloadStart + payloadLength;
  if (buffer.length < end) {
    return null;
  }
  return {
    payload: Uint8Array.from(buffer.subarray(payloadStart, end)),
    end,
  };
}

function consumeSeparator(buffer: Buffer, start: number): number | null {
  if (buffer.length <= start) {
    return null;
  }
  const byte = buffer[start];
  if (byte === 0x3b || byte === 0x0a) {
    return start + 1;
  }
  if (byte === 0x0d) {
    if (buffer.length <= start + 1) {
      return null;
    }
    if (buffer[start + 1] !== 0x0a) {
      throw new Error(`Expected LF after CR at byte ${start}`);
    }
    return start + 2;
  }
  throw new Error(`Expected binary response separator at byte ${start}, got 0x${byte?.toString(16)}`);
}

function parseBinaryBlocks(expectedCount: number): Parser<Uint8Array[]> {
  return (buffer) => {
    let position = 0;
    const blocks: Uint8Array[] = [];

    for (let index = 0; index < expectedCount; index += 1) {
      if (index > 0) {
        const next = consumeSeparator(buffer, position);
        if (next === null) {
          return null;
        }
        position = next;
      }

      const block = parseBlockAt(buffer, position);
      if (block === null) {
        return null;
      }
      blocks.push(block.payload);
      position = block.end;
    }

    if (buffer.length <= position) {
      return null;
    }
    if (buffer[position] === 0x0a) {
      position += 1;
    } else if (buffer[position] === 0x0d) {
      if (buffer.length <= position + 1) {
        return null;
      }
      if (buffer[position + 1] !== 0x0a) {
        throw new Error(`Expected final LF after CR at byte ${position}`);
      }
      position += 2;
    } else {
      throw new Error(`Expected final line terminator at byte ${position}`);
    }

    return { value: blocks, consumed: position };
  };
}

function countCompleteLeadingBlocks(buffer: Buffer): number {
  let position = 0;
  let count = 0;
  for (;;) {
    if (count > 0) {
      try {
        const next = consumeSeparator(buffer, position);
        if (next === null) {
          return count;
        }
        position = next;
      } catch {
        return count;
      }
    }
    try {
      const block = parseBlockAt(buffer, position);
      if (block === null) {
        return count;
      }
      count += 1;
      position = block.end;
    } catch {
      return count;
    }
  }
}

class ProbeTransport {
  private readonly socket = new Socket();
  private buffer = Buffer.alloc(0);
  private pending: PendingRead<unknown> | null = null;

  public constructor(private readonly timeoutMs: number) {
    this.socket.setNoDelay(true);
    this.socket.setKeepAlive(true);
    this.socket.on("data", (chunk: Buffer) => this.onData(chunk));
    this.socket.on("error", (error) => this.fail(error));
    this.socket.on("close", () => this.fail(new Error("SCPI socket closed")));
  }

  public async connect(host: string, port: number): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        this.socket.off("connect", onConnect);
        reject(error);
      };
      const onConnect = (): void => {
        this.socket.off("error", onError);
        resolve();
      };
      this.socket.once("error", onError);
      this.socket.once("connect", onConnect);
      this.socket.connect(port, host);
    });
  }

  public disconnect(): void {
    this.socket.destroy();
  }

  public async command(command: string): Promise<void> {
    if (this.pending !== null) {
      throw new Error("Cannot send command while a response is pending");
    }
    await this.write(command);
  }

  public queryText(command: string): Promise<string> {
    return this.query(command, parseText);
  }

  public queryBinaryBlocks(command: string, expectedCount: number): Promise<Uint8Array[]> {
    if (!Number.isInteger(expectedCount) || expectedCount < 1) {
      throw new Error("expectedCount must be a positive integer");
    }
    return this.query(command, parseBinaryBlocks(expectedCount));
  }

  private async query<T>(command: string, parser: Parser<T>): Promise<T> {
    if (this.pending !== null) {
      throw new Error("A SCPI response is already pending");
    }
    if (this.buffer.length !== 0) {
      throw new Error(`Unexpected ${this.buffer.length} buffered bytes before ${command}`);
    }

    const response = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        const completeBlocks = countCompleteLeadingBlocks(this.buffer);
        const error = new Error(
          `Timed out after ${this.timeoutMs} ms waiting for ${command}; ` +
          `${this.buffer.length} bytes buffered, ${completeBlocks} complete leading binary block(s)`,
        );
        this.fail(error);
      }, this.timeoutMs);
      this.pending = {
        command,
        parser: parser as Parser<unknown>,
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      };
    });

    try {
      await this.write(command);
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
    return response;
  }

  private async write(command: string): Promise<void> {
    if (command.includes("\n") || command.includes("\r")) {
      throw new Error("SCPI program message must not contain line terminators");
    }
    await new Promise<void>((resolve, reject) => {
      this.socket.write(`${command}\n`, (error) => {
        if (error !== null && error !== undefined) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  private onData(chunk: Buffer): void {
    const pending = this.pending;
    if (pending === null) {
      this.fail(new Error(`Received ${chunk.length} SCPI bytes without a pending query`));
      return;
    }
    this.buffer = Buffer.concat([this.buffer, chunk]);
    try {
      const parsed = pending.parser(this.buffer);
      if (parsed === null) {
        return;
      }
      if (parsed.consumed !== this.buffer.length) {
        throw new Error(
          `Parser consumed ${parsed.consumed} of ${this.buffer.length} bytes for ${pending.command}`,
        );
      }
      this.buffer = Buffer.alloc(0);
      this.pending = null;
      clearTimeout(pending.timer);
      pending.resolve(parsed.value);
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private fail(error: Error): void {
    const pending = this.pending;
    this.pending = null;
    if (pending !== null) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.socket.destroy();
  }
}

function validateBlocks(blocks: Uint8Array[], label: string): void {
  if (blocks.length !== CHANNELS.length) {
    throw new Error(`${label} expected ${CHANNELS.length} blocks, got ${blocks.length}`);
  }
  blocks.forEach((block, index) => {
    if (block.byteLength !== POINT_COUNT) {
      throw new Error(
        `${label} CH${CHANNELS[index]} expected ${POINT_COUNT} bytes, got ${block.byteLength}`,
      );
    }
  });
}

async function time<T>(operation: () => Promise<T>): Promise<{ elapsedMs: number; value: T }> {
  const startedAt = performance.now();
  const value = await operation();
  return { elapsedMs: performance.now() - startedAt, value };
}

function compoundFourChannelQuery(): string {
  return CHANNELS.flatMap((channel) => [
    `:WAVeform:SOURce CHANnel${channel}`,
    ":WAVeform:DATA?",
  ]).join(";");
}

async function run(): Promise<void> {
  const host = requireHost();
  const port = requirePort();
  const transport = new ProbeTransport(RESPONSE_TIMEOUT_MS);
  const separateMs: number[] = [];
  const compoundMs: number[] = [];

  console.info(`[SCPI-PROBE] four-channel-compound:start ${JSON.stringify({
    host,
    port,
    rounds: ROUNDS,
    points: POINT_COUNT,
    timeoutMs: RESPONSE_TIMEOUT_MS,
  })}`);

  try {
    await transport.connect(host, port);
    const idn = await transport.queryText("*IDN?");
    console.info(`[SCPI-PROBE] identity ${JSON.stringify({ idn })}`);

    await transport.command(":WAVeform:MODE NORM");
    await transport.command(":WAVeform:FORMat BYTE");
    await transport.command(`:WAVeform:POINts ${POINT_COUNT}`);

    const runSeparate = async (): Promise<void> => {
      const measured = await time(async () => {
        const blocks: Uint8Array[] = [];
        for (const channel of CHANNELS) {
          await transport.command(`:WAVeform:SOURce CHANnel${channel}`);
          const [block] = await transport.queryBinaryBlocks(":WAVeform:DATA?", 1);
          if (block === undefined) {
            throw new Error(`Separate CH${channel} read returned no binary block`);
          }
          blocks.push(block);
        }
        return blocks;
      });
      validateBlocks(measured.value, "separate");
      separateMs.push(measured.elapsedMs);
    };

    const compoundCommand = compoundFourChannelQuery();
    const runCompound = async (): Promise<void> => {
      const measured = await time(() => transport.queryBinaryBlocks(compoundCommand, CHANNELS.length));
      validateBlocks(measured.value, "compound");
      compoundMs.push(measured.elapsedMs);
    };

    for (let round = 0; round < ROUNDS; round += 1) {
      if (round % 2 === 0) {
        await runSeparate();
        await runCompound();
      } else {
        await runCompound();
        await runSeparate();
      }
    }

    const separate = summarize(separateMs);
    const compound = summarize(compoundMs);
    console.info(`[SCPI-PROBE] four-channel-compound:summary ${JSON.stringify({
      rounds: ROUNDS,
      points: POINT_COUNT,
      separate,
      compound,
      medianRatio: compound.medianMs / separate.medianMs,
    })}`);
  } finally {
    transport.disconnect();
  }
}

run().catch((error: unknown) => {
  console.error(`[SCPI-PROBE] four-channel-compound:failed ${JSON.stringify({
    error: error instanceof Error ? error.message : String(error),
  })}`);
  process.exitCode = 1;
});
