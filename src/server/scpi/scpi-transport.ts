import { Socket } from "node:net";

export enum ScpiResponseKind {
  Text = 1,
  Binary = 2,
}

export type ScpiResponse =
  | { kind: ScpiResponseKind.Text; value: string }
  | { kind: ScpiResponseKind.Binary; value: Uint8Array };

export class ScpiResponseTypeError extends Error {}
export class ScpiTransportError extends Error {}

interface PendingResponseBase {
  command: string;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  startedAt: number;
  bytesReadAtStart: number;
}

type PendingResponse =
  | (PendingResponseBase & {
      kind: "single";
      resolve: (response: ScpiResponse) => void;
    })
  | (PendingResponseBase & {
      kind: "binary-blocks";
      expectedBlocks: number;
      resolve: (blocks: Uint8Array[]) => void;
    });

interface ParsedBinaryBlock {
  payload: Uint8Array;
  end: number;
}

const SUPPRESSED_DEBUG_EVENTS = new Set([
  "query:start",
  "query:data",
  "query:binary-progress",
]);

function scpiDebug(event: string, detail: Record<string, unknown>): void {
  if (SUPPRESSED_DEBUG_EVENTS.has(event)) {
    return;
  }
  console.debug(`[SCPI] ${event} ${JSON.stringify(detail)}`);
}

export class ScpiTransport {
  private socket: Socket | null = null;
  private pending: PendingResponse | null = null;
  private receiveBuffer = Buffer.alloc(0);
  private usable = false;
  private cancelPendingConnect: ((error: Error) => void) | null = null;

  public constructor(private readonly responseTimeoutMs = 5_000) {
    if (!Number.isFinite(responseTimeoutMs) || responseTimeoutMs <= 0) {
      throw new Error("responseTimeoutMs must be a positive finite number");
    }
  }

  public isUsable(): boolean {
    return this.usable;
  }

  public async connect(host: string, port: number): Promise<void> {
    if (this.socket !== null) {
      throw new ScpiTransportError("SCPI transport is already connected");
    }
    if (host.length === 0 || !Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new Error("Invalid SCPI host or port");
    }

    const socket = new Socket();
    socket.setNoDelay(true);
    socket.setKeepAlive(true);

    socket.on("data", (chunk) => this.onData(chunk));
    socket.on("error", (error) => this.invalidate(error));
    socket.on("close", () => {
      if (this.usable || this.pending !== null) {
        this.invalidate(new ScpiTransportError("SCPI socket closed"));
      }
    });

    this.socket = socket;
    scpiDebug("connect:start", { host, port });

    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;

        const cleanup = (): void => {
          socket.off("connect", onConnect);
          socket.off("error", onInitialError);
          socket.off("close", onInitialClose);
          this.cancelPendingConnect = null;
        };
        const fail = (error: Error): void => {
          if (settled) {
            return;
          }
          settled = true;
          cleanup();
          reject(error);
        };
        const onConnect = (): void => {
          if (settled) {
            return;
          }
          settled = true;
          cleanup();
          resolve();
        };
        const onInitialError = (error: Error): void => {
          fail(error);
        };
        const onInitialClose = (): void => {
          fail(new ScpiTransportError("SCPI socket closed before connecting"));
        };

        this.cancelPendingConnect = fail;
        socket.once("connect", onConnect);
        socket.once("error", onInitialError);
        socket.once("close", onInitialClose);
        socket.connect(port, host);
      });
      this.usable = true;
      scpiDebug("connect:ready", {
        host,
        port,
        localAddress: socket.localAddress,
        localPort: socket.localPort,
      });
    } catch (error) {
      this.cancelPendingConnect = null;
      if (this.socket === socket) {
        this.socket = null;
      }
      socket.destroy();
      scpiDebug("connect:failed", {
        host,
        port,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  public disconnect(reason: Error = new ScpiTransportError("SCPI transport disconnected")): void {
    const cancelPendingConnect = this.cancelPendingConnect;
    this.cancelPendingConnect = null;
    cancelPendingConnect?.(reason);

    const socket = this.socket;
    const pending = this.pending;
    scpiDebug("disconnect", {
      reason: reason.message,
      pendingCommand: pending?.command ?? null,
      bufferedBytes: this.receiveBuffer.length,
      socketBytesRead: socket?.bytesRead ?? 0,
      socketBytesWritten: socket?.bytesWritten ?? 0,
    });
    this.socket = null;
    this.usable = false;
    this.receiveBuffer = Buffer.alloc(0);
    if (pending !== null) {
      this.pending = null;
      clearTimeout(pending.timer);
      pending.reject(reason);
    }
    socket?.destroy();
  }

  public async command(command: string): Promise<void> {
    this.assertReadyForTransaction();
    scpiDebug("command", { command });
    await this.writeProgramMessage(command);
  }

  public async query(command: string): Promise<ScpiResponse> {
    this.assertReadyForTransaction();
    if (this.pending !== null) {
      throw new ScpiTransportError("A SCPI response is already pending");
    }

    const socket = this.requireSocket();
    const startedAt = performance.now();
    const bytesReadAtStart = socket.bytesRead;
    scpiDebug("query:start", {
      command,
      timeoutMs: this.responseTimeoutMs,
      socketBytesRead: bytesReadAtStart,
    });

    const responsePromise = new Promise<ScpiResponse>((resolve, reject) => {
      const timer = this.createResponseTimer(command, startedAt, bytesReadAtStart);
      this.pending = {
        kind: "single",
        command,
        resolve,
        reject,
        timer,
        startedAt,
        bytesReadAtStart,
      };
    });

    await this.writeQueryProgramMessage(command);
    return responsePromise;
  }

  public async queryText(command: string): Promise<string> {
    const response = await this.query(command);
    if (response.kind !== ScpiResponseKind.Text) {
      throw new ScpiResponseTypeError(`Expected text response for ${command}, received binary block`);
    }
    return response.value;
  }

  public async queryBinary(command: string): Promise<Uint8Array> {
    const response = await this.query(command);
    if (response.kind !== ScpiResponseKind.Binary) {
      throw new ScpiResponseTypeError(`Expected binary response for ${command}, received text`);
    }
    return response.value;
  }

  public async queryBinaryBlocks(command: string, expectedBlocks: number): Promise<Uint8Array[]> {
    this.assertReadyForTransaction();
    if (!Number.isSafeInteger(expectedBlocks) || expectedBlocks < 1) {
      throw new Error("expectedBlocks must be a positive safe integer");
    }
    if (this.pending !== null) {
      throw new ScpiTransportError("A SCPI response is already pending");
    }

    const socket = this.requireSocket();
    const startedAt = performance.now();
    const bytesReadAtStart = socket.bytesRead;
    scpiDebug("query:start", {
      command,
      timeoutMs: this.responseTimeoutMs,
      expectedBlocks,
      socketBytesRead: bytesReadAtStart,
    });

    const responsePromise = new Promise<Uint8Array[]>((resolve, reject) => {
      const timer = this.createResponseTimer(command, startedAt, bytesReadAtStart);
      this.pending = {
        kind: "binary-blocks",
        command,
        expectedBlocks,
        resolve,
        reject,
        timer,
        startedAt,
        bytesReadAtStart,
      };
    });

    await this.writeQueryProgramMessage(command);
    return responsePromise;
  }

  private requireSocket(): Socket {
    const socket = this.socket;
    if (socket === null) {
      throw new ScpiTransportError("SCPI transport is not usable");
    }
    return socket;
  }

  private createResponseTimer(
    command: string,
    startedAt: number,
    bytesReadAtStart: number,
  ): NodeJS.Timeout {
    return setTimeout(() => {
      const pending = this.pending;
      const currentSocket = this.socket;
      const bytesRead = currentSocket?.bytesRead ?? bytesReadAtStart;
      const receivedBytes = Math.max(0, bytesRead - bytesReadAtStart);
      const bufferedBytes = this.receiveBuffer.length;
      scpiDebug("query:timeout", {
        command,
        elapsedMs: performance.now() - startedAt,
        receivedBytes,
        bufferedBytes,
        bufferPrefixHex: this.receiveBuffer.subarray(0, 24).toString("hex"),
        pendingCommand: pending?.command ?? null,
      });
      this.invalidate(new ScpiTransportError(
        `SCPI query timed out after ${this.responseTimeoutMs} ms while waiting for ${command} ` +
        `(received ${receivedBytes} bytes, ${bufferedBytes} buffered)`,
      ));
    }, this.responseTimeoutMs);
  }

  private async writeQueryProgramMessage(command: string): Promise<void> {
    try {
      await this.writeProgramMessage(command);
    } catch (error) {
      this.invalidate(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  private assertReadyForTransaction(): void {
    if (!this.usable || this.socket === null) {
      throw new ScpiTransportError("SCPI transport is not usable");
    }
  }

  private async writeProgramMessage(command: string): Promise<void> {
    const socket = this.socket;
    if (socket === null || !this.usable) {
      throw new ScpiTransportError("SCPI transport is not usable");
    }
    if (command.includes("\n") || command.includes("\r")) {
      throw new Error("SCPI command must contain exactly one program message without line terminators");
    }

    await new Promise<void>((resolve, reject) => {
      socket.write(`${command}\n`, (error) => {
        if (error !== undefined && error !== null) {
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
      this.invalidate(new ScpiTransportError("Received SCPI data without an active query"));
      return;
    }

    this.receiveBuffer = Buffer.concat([this.receiveBuffer, chunk]);
    scpiDebug("query:data", {
      command: pending.command,
      chunkBytes: chunk.length,
      bufferedBytes: this.receiveBuffer.length,
      chunkPrefixHex: chunk.subarray(0, 16).toString("hex"),
    });

    try {
      if (pending.kind === "single") {
        const response = this.tryParseResponse();
        if (response === null) {
          return;
        }
        this.pending = null;
        clearTimeout(pending.timer);
        scpiDebug("query:complete", {
          command: pending.command,
          elapsedMs: Number((performance.now() - pending.startedAt).toFixed(3)),
          responseKind: response.kind === ScpiResponseKind.Binary ? "binary" : "text",
          responseBytes: response.kind === ScpiResponseKind.Binary
            ? response.value.byteLength
            : Buffer.byteLength(response.value),
          socketBytesRead: this.socket?.bytesRead ?? pending.bytesReadAtStart,
        });
        pending.resolve(response);
        return;
      }

      const blocks = this.tryParseBinaryBlocks(pending.expectedBlocks);
      if (blocks === null) {
        return;
      }
      this.pending = null;
      clearTimeout(pending.timer);
      scpiDebug("query:complete", {
        command: pending.command,
        elapsedMs: Number((performance.now() - pending.startedAt).toFixed(3)),
        responseKind: "binary-blocks",
        responseBlocks: blocks.length,
        responseBytes: blocks.reduce((sum, block) => sum + block.byteLength, 0),
        socketBytesRead: this.socket?.bytesRead ?? pending.bytesReadAtStart,
      });
      pending.resolve(blocks);
    } catch (error) {
      this.invalidate(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private tryParseResponse(): ScpiResponse | null {
    if (this.receiveBuffer.length === 0) {
      return null;
    }

    if (this.receiveBuffer[0] === 0x23) {
      return this.tryParseBinaryResponse();
    }
    return this.tryParseTextResponse();
  }

  private tryParseTextResponse(): ScpiResponse | null {
    const newlineIndex = this.receiveBuffer.indexOf(0x0a);
    if (newlineIndex < 0) {
      return null;
    }

    let textEnd = newlineIndex;
    if (textEnd > 0 && this.receiveBuffer[textEnd - 1] === 0x0d) {
      textEnd -= 1;
    }
    const value = this.receiveBuffer.subarray(0, textEnd).toString("utf8");
    this.receiveBuffer = this.receiveBuffer.subarray(newlineIndex + 1);
    if (this.receiveBuffer.length !== 0) {
      throw new ScpiTransportError("Unexpected trailing bytes after SCPI text response");
    }
    return { kind: ScpiResponseKind.Text, value };
  }

  private tryParseBinaryResponse(): ScpiResponse | null {
    const block = this.tryParseBinaryBlockAt(0);
    if (block === null) {
      return null;
    }
    const responseEnd = this.tryConsumeLineTerminator(block.end);
    if (responseEnd === null) {
      return null;
    }
    if (responseEnd !== this.receiveBuffer.length) {
      throw new ScpiTransportError("Unexpected trailing bytes after IEEE/TMC binary response");
    }
    this.receiveBuffer = Buffer.alloc(0);
    return { kind: ScpiResponseKind.Binary, value: block.payload };
  }

  private tryParseBinaryBlocks(expectedBlocks: number): Uint8Array[] | null {
    let position = 0;
    const blocks: Uint8Array[] = [];

    for (let index = 0; index < expectedBlocks; index += 1) {
      if (index > 0) {
        const nextPosition = this.tryConsumeBinaryBlockSeparator(position);
        if (nextPosition === null) {
          return null;
        }
        position = nextPosition;
      }

      const block = this.tryParseBinaryBlockAt(position);
      if (block === null) {
        return null;
      }
      blocks.push(block.payload);
      position = block.end;
    }

    const responseEnd = this.tryConsumeLineTerminator(position);
    if (responseEnd === null) {
      return null;
    }
    if (responseEnd !== this.receiveBuffer.length) {
      throw new ScpiTransportError("Unexpected trailing bytes after compound IEEE/TMC binary response");
    }
    this.receiveBuffer = Buffer.alloc(0);
    return blocks;
  }

  private tryParseBinaryBlockAt(start: number): ParsedBinaryBlock | null {
    if (this.receiveBuffer.length <= start + 1) {
      return null;
    }
    if (this.receiveBuffer[start] !== 0x23) {
      throw new ScpiTransportError(`Expected IEEE/TMC binary block at byte ${start}`);
    }

    const digitByte = this.receiveBuffer[start + 1];
    if (digitByte === undefined || digitByte < 0x31 || digitByte > 0x39) {
      throw new ScpiTransportError("Malformed IEEE/TMC binary block digit count");
    }
    const digitCount = digitByte - 0x30;
    const lengthStart = start + 2;
    const payloadStart = lengthStart + digitCount;
    if (this.receiveBuffer.length < payloadStart) {
      return null;
    }

    const lengthText = this.receiveBuffer.subarray(lengthStart, payloadStart).toString("ascii");
    if (!/^\d+$/.test(lengthText)) {
      throw new ScpiTransportError("Malformed IEEE/TMC binary block payload length");
    }
    const payloadLength = Number(lengthText);
    if (!Number.isSafeInteger(payloadLength) || payloadLength < 0) {
      throw new ScpiTransportError("Invalid IEEE/TMC binary block payload length");
    }

    const payloadEnd = payloadStart + payloadLength;
    if (this.receiveBuffer.length < payloadEnd) {
      scpiDebug("query:binary-progress", {
        command: this.pending?.command ?? null,
        payloadBytesExpected: payloadLength,
        payloadBytesBuffered: Math.max(0, this.receiveBuffer.length - payloadStart),
        totalBytesBuffered: this.receiveBuffer.length,
      });
      return null;
    }

    return {
      payload: Uint8Array.from(this.receiveBuffer.subarray(payloadStart, payloadEnd)),
      end: payloadEnd,
    };
  }

  private tryConsumeBinaryBlockSeparator(position: number): number | null {
    if (this.receiveBuffer.length <= position) {
      return null;
    }
    const byte = this.receiveBuffer[position];
    if (byte === 0x23) {
      return position;
    }
    if (byte === 0x3b || byte === 0x0a) {
      return position + 1;
    }
    if (byte === 0x0d) {
      if (this.receiveBuffer.length <= position + 1) {
        return null;
      }
      if (this.receiveBuffer[position + 1] !== 0x0a) {
        throw new ScpiTransportError(`Expected LF after CR at byte ${position}`);
      }
      return position + 2;
    }
    throw new ScpiTransportError(
      `Expected separator before compound IEEE/TMC binary block at byte ${position}`,
    );
  }

  private tryConsumeLineTerminator(position: number): number | null {
    if (this.receiveBuffer.length <= position) {
      return null;
    }
    if (this.receiveBuffer[position] === 0x0a) {
      return position + 1;
    }
    if (this.receiveBuffer[position] === 0x0d) {
      if (this.receiveBuffer.length <= position + 1) {
        return null;
      }
      if (this.receiveBuffer[position + 1] === 0x0a) {
        return position + 2;
      }
    }
    throw new ScpiTransportError("Missing terminator after IEEE/TMC binary block response");
  }

  private invalidate(error: Error): void {
    const socket = this.socket;
    const pending = this.pending;
    scpiDebug("invalidate", {
      error: error.message,
      pendingCommand: pending?.command ?? null,
      bufferedBytes: this.receiveBuffer.length,
      bufferPrefixHex: this.receiveBuffer.subarray(0, 24).toString("hex"),
      socketBytesRead: socket?.bytesRead ?? 0,
      socketBytesWritten: socket?.bytesWritten ?? 0,
    });
    this.socket = null;
    this.usable = false;
    this.receiveBuffer = Buffer.alloc(0);

    if (pending !== null) {
      this.pending = null;
      clearTimeout(pending.timer);
      pending.reject(error);
    }

    if (socket !== null && !socket.destroyed) {
      socket.destroy();
    }
  }
}
