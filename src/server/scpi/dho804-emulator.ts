import { createServer, type Server, type Socket } from "node:net";

export interface Dho804EmulatorOptions {
  responseChunkDelayMs?: number;
  earlyDataWindowMs?: number;
}

export class Dho804Emulator {
  private readonly server: Server;
  private readonly responseChunkDelayMs: number;
  private readonly earlyDataWindowMs: number;
  private readonly sockets = new Set<Socket>();
  private readonly payload = Uint8Array.from({ length: 999 }, (_, index) => index & 0xff);
  private stoppedAt = 0;
  private running = false;
  private scale = 1e-5;
  private points = 999;
  private source = "CHANnel1";

  public constructor(options: Dho804EmulatorOptions = {}) {
    this.responseChunkDelayMs = options.responseChunkDelayMs ?? 60;
    this.earlyDataWindowMs = options.earlyDataWindowMs ?? 50;
    this.server = createServer((socket) => this.handleSocket(socket));
  }

  public async listen(): Promise<number> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    const address = this.server.address();
    if (address === null || typeof address === "string") throw new Error("DHO804 emulator did not bind");
    return address.port;
  }

  public async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private handleSocket(socket: Socket): void {
    this.sockets.add(socket);
    let buffered = "";
    socket.on("data", (chunk) => {
      buffered += chunk.toString("utf8");
      for (;;) {
        const newline = buffered.indexOf("\n");
        if (newline < 0) return;
        const command = buffered.slice(0, newline).replace(/\r$/, "");
        buffered = buffered.slice(newline + 1);
        void this.handleCommand(socket, command);
      }
    });
    socket.on("close", () => this.sockets.delete(socket));
  }

  private async handleCommand(socket: Socket, command: string): Promise<void> {
    if (command === ":STOP") {
      this.running = false;
      this.stoppedAt = Date.now();
      return;
    }
    if (command === ":RUN") {
      this.running = true;
      return;
    }
    if (command.startsWith(":TIMebase:MAIN:SCALe ")) {
      this.scale = Number(command.slice(command.indexOf(" ") + 1));
      return;
    }
    if (command.startsWith(":WAVeform:POINts ")) {
      this.points = Number(command.slice(command.indexOf(" ") + 1));
      return;
    }
    if (command.startsWith(":WAVeform:SOURce ")) {
      this.source = command.slice(command.indexOf(" ") + 1);
      return;
    }
    if (command === "*IDN?") return this.writeText(socket, "RIGOL TECHNOLOGIES,DHO804,EMULATOR,00.01.04");
    if (command === ":TIMebase:MAIN:SCALe?") return this.writeText(socket, this.scale.toExponential(6));
    if (command === ":WAVeform:PREamble?") {
      return this.writeText(socket, `0,0,${this.points},1,${(this.scale / 100).toExponential(6)},0,0,0.5,10,0`);
    }
    if (command === ":WAVeform:DATA?") {
      const early = !this.running || Date.now() - this.stoppedAt < this.earlyDataWindowMs;
      return this.writeWaveform(socket, early);
    }
  }

  private writeText(socket: Socket, value: string): void {
    socket.write(`${value}\n`);
  }

  private async writeWaveform(socket: Socket, early: boolean): Promise<void> {
    const payloadLength = early ? 501 : this.points;
    const payload = Buffer.from(this.payload.subarray(0, payloadLength));
    payload[0] = ((payload[0] ?? 0) + this.source.length) & 0xff;
    const block = Buffer.concat([Buffer.from(`#9${String(this.points).padStart(9, "0")}`), payload, Buffer.from("\n")]);
    socket.write(block.subarray(0, Math.min(512, block.length)));
    if (early) return;
    await new Promise<void>((resolve) => setTimeout(resolve, this.responseChunkDelayMs));
    if (!socket.destroyed) socket.write(block.subarray(512));
  }
}
