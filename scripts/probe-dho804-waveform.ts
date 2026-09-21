import { Socket } from "node:net";

interface TextResponse {
  kind: "text";
  value: string;
  receivedBytes: number;
  elapsedMs: number;
  complete: true;
}

interface BinaryResponse {
  kind: "binary";
  payloadLength: number;
  receivedBytes: number;
  elapsedMs: number;
  complete: true;
}

interface TimeoutResponse {
  kind: "timeout";
  receivedBytes: number;
  elapsedMs: number;
  complete: false;
  prefixHex: string;
}

type ProbeResponse = TextResponse | BinaryResponse | TimeoutResponse;

interface Connection {
  socket: Socket;
  chunks: Buffer[];
  bytes: number;
  consumed: number;
  connected: Promise<void>;
}

const host = process.env.RIGOL_HOST ?? "192.168.1.8";
const port = Number(process.env.RIGOL_PORT ?? 5555);
const scales = (process.argv.slice(2).length > 0
  ? process.argv.slice(2)
  : ["0.00001", "0.00002", "0.00001", "0.00002"])
  .map(Number);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function connect(): Connection {
  const socket = new Socket();
  socket.setNoDelay(true);
  const connection: Connection = {
    socket,
    chunks: [],
    bytes: 0,
    consumed: 0,
    connected: new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    }),
  };
  socket.on("data", (chunk: Buffer) => {
    connection.chunks.push(chunk);
    connection.bytes += chunk.length;
  });
  socket.connect(port, host);
  return connection;
}

async function readResponse(connection: Connection, timeoutMs = 3000): Promise<ProbeResponse> {
  const started = performance.now();
  const responseStart = connection.consumed;
  while (performance.now() - started < timeoutMs) {
    const available = Buffer.concat(connection.chunks);
    if (available.length > responseStart) {
      const data = available.subarray(responseStart);
      const hash = data.indexOf(0x23);
      if (hash >= 0 && data.length >= hash + 2 && data[hash + 1] >= 0x31 && data[hash + 1] <= 0x39) {
        const digits = data[hash + 1] - 0x30;
        const lengthStart = hash + 2;
        const payloadStart = lengthStart + digits;
        if (data.length >= payloadStart) {
          const payloadLength = Number(data.subarray(lengthStart, payloadStart).toString("ascii"));
          const end = payloadStart + payloadLength;
          if (data.length >= end) {
            const terminatorLength = data[end] === 0x0a
              ? 1
              : data[end] === 0x0d && data[end + 1] === 0x0a ? 2 : 0;
            connection.consumed = responseStart + end + terminatorLength;
            return {
              kind: "binary",
              payloadLength,
              receivedBytes: data.length,
              elapsedMs: performance.now() - started,
              complete: true,
            };
          }
          await sleep(10);
          continue;
        }
      }
      const newline = data.indexOf(0x0a);
      if (newline >= 0) {
        connection.consumed = responseStart + newline + 1;
        return {
          kind: "text",
          value: data.subarray(0, newline).toString("utf8"),
          receivedBytes: data.length,
          elapsedMs: performance.now() - started,
          complete: true,
        };
      }
    }
    await sleep(10);
  }
  return {
    kind: "timeout",
    receivedBytes: connection.bytes,
    elapsedMs: performance.now() - started,
    complete: false,
    prefixHex: Buffer.concat(connection.chunks).subarray(0, 32).toString("hex"),
  };
}

async function query(connection: Connection, command: string): Promise<ProbeResponse> {
  connection.socket.write(`${command}\n`);
  return readResponse(connection);
}

const connection = connect();
await connection.connected;
console.log(JSON.stringify({ event: "connected", host, port }));
console.log(JSON.stringify({ command: "*IDN?", response: await query(connection, "*IDN?") }));

for (const scale of scales) {
  const started = performance.now();
  connection.socket.write(":STOP\n");
  await sleep(50);
  connection.socket.write(`:TIMebase:MAIN:SCALe ${scale}\n`);
  const scaleReadback = await query(connection, ":TIMebase:MAIN:SCALe?");
  connection.socket.write(":RUN\n");
  await sleep(100);
  connection.socket.write(":WAVeform:MODE NORM\n:WAVeform:FORMat BYTE\n:WAVeform:POINts 999\n:WAVeform:SOURce CHANnel1\n");
  const preamble = await query(connection, ":WAVeform:PREamble?");
  const data = await query(connection, ":WAVeform:DATA?");
  let sameSocketReadback: ProbeResponse | undefined;
  if (data.kind === "timeout") {
    // Deliberately attempt to reuse the stream after the suspected truncated
    // block. If the scope/socket is still synchronized, this must be a clean
    // text response rather than another timeout or mixed binary/text data.
    await sleep(100);
    sameSocketReadback = await query(connection, ":TIMebase:MAIN:SCALe?");
  }
  console.log(JSON.stringify({
    event: "scenario",
    scale,
    elapsedMs: performance.now() - started,
    scaleReadback,
    preamble,
    data,
    sameSocketReadback,
  }));
}

connection.socket.destroy();
