import {
  createServer as createNetServer,
  type AddressInfo,
  type Server as NetServer,
  type Socket,
} from "node:net";

import { describe, expect, it } from "vitest";

import {
  DmmAcquisitionRate,
  DmmControlKind,
  DmmMeasurementFunction,
  DmmRangeMode,
  DmmReadingKind,
  DmmUnit,
  type DmmReadingSnapshot,
  type DmmState,
} from "../../shared/dmm-types.js";
import {
  ServerDmmConnectionKind,
  type ServerDmmConnection,
} from "../websocket/websocket-gateway.js";
import { DmmRuntime } from "./dmm-runtime.js";

type ConnectedDmmConnection = Extract<
  ServerDmmConnection,
  { kind: ServerDmmConnectionKind.Connected }
>;

interface FakeConnection {
  index: number;
  socket: Socket;
  commands: string[];
  buffer: string;
}

async function listen(server: NetServer): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("error", onError);
      reject(error);
    };
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Expected local TCP server address");
  }
  return (address as AddressInfo).port;
}

async function closeServer(server: NetServer): Promise<void> {
  if (!server.listening) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error !== undefined) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor<T>(read: () => T | undefined, timeoutMs = 3_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) {
      return value;
    }
    await delay(10);
  }
  throw new Error(`Timed out after ${timeoutMs} ms`);
}

class FakeDm858eServer {
  public readonly server = createNetServer((socket) => this.accept(socket));
  public readonly connections: FakeConnection[] = [];
  public functionToken = "VOLT";
  public rangeAuto = true;
  public range = 10;
  public nplc = 20;
  public blockReadings = false;
  public latestReading = "-1.25000000E-01 VDC";

  public async start(): Promise<number> {
    return listen(this.server);
  }

  public setFrontPanelFunction(functionToken: string): void {
    this.functionToken = functionToken;
    this.rangeAuto = true;
    this.range = defaultRangeFor(functionToken);
    this.nplc = 20;
    this.latestReading = readingResponseFor(functionToken);
  }

  public disconnect(index: number): void {
    this.connections[index - 1]?.socket.destroy();
  }

  public async stop(): Promise<void> {
    for (const connection of this.connections) {
      connection.socket.destroy();
    }
    await closeServer(this.server);
  }

  private accept(socket: Socket): void {
    const connection: FakeConnection = {
      index: this.connections.length + 1,
      socket,
      commands: [],
      buffer: "",
    };
    this.connections.push(connection);

    socket.on("data", (chunk) => {
      connection.buffer += chunk.toString("utf8");
      while (true) {
        const newline = connection.buffer.indexOf("\n");
        if (newline < 0) {
          break;
        }
        const command = connection.buffer.slice(0, newline).replace(/\r$/, "");
        connection.buffer = connection.buffer.slice(newline + 1);
        connection.commands.push(command);
        this.handleCommand(connection, command);
      }
    });
  }

  private handleCommand(connection: FakeConnection, command: string): void {
    if (command.startsWith("SENSe:FUNCtion ")) {
      this.setFrontPanelFunction(functionTokenFromSetCommand(command));
      return;
    }

    if (command.endsWith(":RANGe:AUTO ON")) {
      this.rangeAuto = true;
      return;
    }

    const rangeMatch = /:RANGe ([+\-0-9.Ee]+)$/.exec(command);
    if (rangeMatch?.[1] !== undefined) {
      this.range = Number(rangeMatch[1]);
      this.rangeAuto = false;
      return;
    }

    const nplcMatch = /:NPLC ([+\-0-9.Ee]+)$/.exec(command);
    if (nplcMatch?.[1] !== undefined) {
      this.nplc = Number(nplcMatch[1]);
      return;
    }

    const configureMatch = /^CONFigure:(VOLTage:AC|CURRent:AC) (AUTO|[+\-0-9.Ee]+),([+\-0-9.Ee]+)$/.exec(command);
    if (configureMatch !== null) {
      this.setFrontPanelFunction(configureMatch[1] === "VOLTage:AC" ? "VOLT:AC" : "CURR:AC");
      this.rangeAuto = configureMatch[2] === "AUTO";
      if (!this.rangeAuto && configureMatch[2] !== undefined) {
        this.range = Number(configureMatch[2]);
      }
      return;
    }

    if (command === "DATA:LAST?" && this.blockReadings) {
      return;
    }

    const response = this.responseFor(command, connection.index);
    if (response !== undefined) {
      connection.socket.write(`${response}\n`);
    } else if (command.includes("?")) {
      connection.socket.write("0\n");
    }
  }

  private responseFor(command: string, connectionIndex: number): string | undefined {
    if (command === "*IDN?") {
      return `RIGOL TECHNOLOGIES,DM858E,FAKE-${connectionIndex},00.01.00.00.22`;
    }
    if (command === "CONFigure?") {
      return configureResponse(this.functionToken, this.range, this.nplc);
    }
    if (command === "SENSe:FUNCtion?") {
      return this.functionToken;
    }
    if (command.endsWith(":RANGe:AUTO?")) {
      return this.rangeAuto ? "1" : "0";
    }
    if (command.endsWith(":RANGe?")) {
      return this.range.toExponential(8).toUpperCase();
    }
    if (command.endsWith(":NPLC?")) {
      return this.nplc.toExponential(8).toUpperCase();
    }
    if (command === "DATA:LAST?") {
      return this.latestReading;
    }
    if (command === "STATus:OPERation:CONDition?") {
      return "0";
    }
    if (command === "STATus:QUEStionable:EVENt?") {
      return "0";
    }
    if (command === "UNIT:TEMPerature?") {
      return "C";
    }
    if (command === "*OPT?") {
      return "NONE";
    }
    return undefined;
  }
}

function functionTokenFromSetCommand(command: string): string {
  const match = /^SENSe:FUNCtion "([^"]+)"$/.exec(command);
  const value = match?.[1];
  switch (value) {
    case "VOLTage:DC": return "VOLT";
    case "VOLTage:AC": return "VOLT:AC";
    case "CURRent:DC": return "CURR";
    case "CURRent:AC": return "CURR:AC";
    case "RESistance": return "RES";
    case "FRESistance": return "FRES";
    case "CONTinuity": return "CONT";
    case "DIODe": return "DIOD";
    case "FREQuency": return "FREQ";
    case "PERiod": return "PER";
    case "CAPacitance": return "CAP";
    case "TEMPerature": return "TEMP";
    default: throw new Error(`Unexpected fake function command: ${command}`);
  }
}

function defaultRangeFor(functionToken: string): number {
  switch (functionToken) {
    case "CURR":
    case "CURR:AC":
      return 1;
    case "RES":
    case "FRES":
      return 1_000;
    case "CAP":
      return 1e-6;
    default:
      return 10;
  }
}

function configureResponse(functionToken: string, range: number, nplc: number): string {
  if (["VOLT", "VOLT:AC", "CURR", "CURR:AC", "RES", "FRES"].includes(functionToken)) {
    const resolutionRatio = nplc === 0.4 ? 1e-3 : nplc === 5 ? 1e-4 : 1e-5;
    return `${functionToken} ${range.toExponential(8).toUpperCase()},${(range * resolutionRatio).toExponential(8).toUpperCase()}`;
  }
  if (functionToken === "CAP") {
    return `CAP ${range.toExponential(8).toUpperCase()}`;
  }
  return functionToken;
}

function readingResponseFor(functionToken: string): string {
  if (functionToken === "VOLT") {
    return "-1.25000000E-01 VDC";
  }
  return `-1.25000000E-01 FAKE_${functionToken.replace(/:/g, "_")}`;
}

describe("DmmRuntime integration", () => {
  it("publishes the existing latest snapshot and applies function-bound controls with readback", async () => {
    const fake = new FakeDm858eServer();
    const port = await fake.start();
    const connected: ConnectedDmmConnection[] = [];
    const states: DmmState[] = [];
    const snapshots: DmmReadingSnapshot[] = [];
    const runtime = new DmmRuntime({
      host: "127.0.0.1",
      port,
      reconnectDelayMs: 20,
      connectTimeoutMs: 500,
      publishConnection: (connection) => {
        if (connection.kind === ServerDmmConnectionKind.Connected) {
          connected.push(connection);
        }
      },
      publishState: (state) => states.push(state),
      publishSnapshot: (snapshot) => snapshots.push(snapshot),
    });

    try {
      runtime.start();
      const connection = await waitFor(() => connected[0]);
      expect(connection.info.serialNumber).toBe("FAKE-1");
      expect(connection.state).toEqual({
        function: DmmMeasurementFunction.DcVoltage,
        range: { mode: DmmRangeMode.Auto },
        acquisitionRate: DmmAcquisitionRate.Slow,
      });

      const firstSnapshot = await waitFor(() => snapshots[0]);
      expect(firstSnapshot).toEqual({
        kind: DmmReadingKind.Value,
        function: DmmMeasurementFunction.DcVoltage,
        value: -0.125,
        resolution: 1e-4,
        unit: DmmUnit.Volts,
      });
      expect(fake.connections[0]?.commands).not.toContain("DATA:POINts?");

      await runtime.setControl({
        kind: DmmControlKind.Function,
        value: DmmMeasurementFunction.Resistance4Wire,
      });
      await waitFor(() => states.find((state) => (
        state.function === DmmMeasurementFunction.Resistance4Wire
      )));

      await runtime.setControl({
        kind: DmmControlKind.Range,
        function: DmmMeasurementFunction.Resistance4Wire,
        value: { mode: DmmRangeMode.Fixed, value: 100 },
      });
      await waitFor(() => states.find((state) => (
        state.function === DmmMeasurementFunction.Resistance4Wire &&
        state.range?.mode === DmmRangeMode.Fixed &&
        state.range.value === 100
      )));

      await runtime.setControl({
        kind: DmmControlKind.AcquisitionRate,
        function: DmmMeasurementFunction.Resistance4Wire,
        value: DmmAcquisitionRate.Fast,
      });
      await waitFor(() => states.find((state) => (
        state.function === DmmMeasurementFunction.Resistance4Wire &&
        state.acquisitionRate === DmmAcquisitionRate.Fast
      )));

      await expect(runtime.executeRawScpi("*OPT?")).resolves.toBe("NONE");
      expect(fake.connections[0]?.commands).toContain("SENSe:FUNCtion \"FRESistance\"");
      expect(fake.connections[0]?.commands).toContain("SENSe:FRESistance:RANGe 100");
      expect(fake.connections[0]?.commands).toContain("SENSe:FRESistance:NPLC 0.4");
      expect(fake.connections[0]?.commands).toContain("*OPT?");
    } finally {
      await runtime.stop();
      await fake.stop();
    }
  });

  it("rejects a queued range request whose originating function is stale", async () => {
    const fake = new FakeDm858eServer();
    const port = await fake.start();
    const connected: ConnectedDmmConnection[] = [];
    const runtime = new DmmRuntime({
      host: "127.0.0.1",
      port,
      reconnectDelayMs: 20,
      connectTimeoutMs: 500,
      publishConnection: (connection) => {
        if (connection.kind === ServerDmmConnectionKind.Connected) {
          connected.push(connection);
        }
      },
      publishState: () => {},
      publishSnapshot: () => {},
    });

    try {
      runtime.start();
      await waitFor(() => connected[0]);

      const changeFunction = runtime.setControl({
        kind: DmmControlKind.Function,
        value: DmmMeasurementFunction.Resistance2Wire,
      });
      const staleRange = runtime.setControl({
        kind: DmmControlKind.Range,
        function: DmmMeasurementFunction.DcVoltage,
        value: { mode: DmmRangeMode.Fixed, value: 1_000 },
      });

      await expect(changeFunction).resolves.toBeUndefined();
      await expect(staleRange).rejects.toThrow(/Stale DMM control/);
      expect(fake.functionToken).toBe("RES");
      expect(fake.connections[0]?.commands).not.toContain("SENSe:RESistance:RANGe 1000");
    } finally {
      await runtime.stop();
      await fake.stop();
    }
  });

  it("rejects a front-panel-stale AC rate request before CONFigure can restore the old function", async () => {
    const fake = new FakeDm858eServer();
    fake.setFrontPanelFunction("VOLT:AC");
    const port = await fake.start();
    const connected: ConnectedDmmConnection[] = [];
    const runtime = new DmmRuntime({
      host: "127.0.0.1",
      port,
      reconnectDelayMs: 20,
      connectTimeoutMs: 500,
      publishConnection: (connection) => {
        if (connection.kind === ServerDmmConnectionKind.Connected) {
          connected.push(connection);
        }
      },
      publishState: () => {},
      publishSnapshot: () => {},
    });

    try {
      runtime.start();
      await waitFor(() => connected[0]);
      fake.setFrontPanelFunction("RES");

      await expect(runtime.setControl({
        kind: DmmControlKind.AcquisitionRate,
        function: DmmMeasurementFunction.AcVoltage,
        value: DmmAcquisitionRate.Fast,
      })).rejects.toThrow(/Stale DMM control/);

      expect(fake.functionToken).toBe("RES");
      expect(fake.connections[0]?.commands.some((command) => (
        command.startsWith("CONFigure:VOLTage:AC ")
      ))).toBe(false);
    } finally {
      await runtime.stop();
      await fake.stop();
    }
  });

  it("stops promptly while a snapshot query is active", async () => {
    const fake = new FakeDm858eServer();
    fake.blockReadings = true;
    const port = await fake.start();
    const connected: ConnectedDmmConnection[] = [];
    const runtime = new DmmRuntime({
      host: "127.0.0.1",
      port,
      reconnectDelayMs: 20,
      connectTimeoutMs: 500,
      publishConnection: (connection) => {
        if (connection.kind === ServerDmmConnectionKind.Connected) {
          connected.push(connection);
        }
      },
      publishState: () => {},
      publishSnapshot: () => {},
    });

    try {
      runtime.start();
      await waitFor(() => connected[0]);
      await waitFor(() => fake.connections[0]?.commands.includes("DATA:LAST?") ? true : undefined);
      const startedAt = Date.now();
      await runtime.stop();
      expect(Date.now() - startedAt).toBeLessThan(500);
    } finally {
      await runtime.stop();
      await fake.stop();
    }
  });

  it("reconnects with a fresh DM858E session after transport loss", async () => {
    const fake = new FakeDm858eServer();
    const port = await fake.start();
    const connected: ConnectedDmmConnection[] = [];
    const runtime = new DmmRuntime({
      host: "127.0.0.1",
      port,
      reconnectDelayMs: 20,
      connectTimeoutMs: 500,
      publishConnection: (connection) => {
        if (connection.kind === ServerDmmConnectionKind.Connected) {
          connected.push(connection);
        }
      },
      publishState: () => {},
      publishSnapshot: () => {},
    });

    try {
      runtime.start();
      const first = await waitFor(() => connected[0]);
      expect(first.info.serialNumber).toBe("FAKE-1");

      fake.disconnect(1);
      const second = await waitFor(() => connected[1], 2_500);
      expect(second.info.serialNumber).toBe("FAKE-2");
    } finally {
      await runtime.stop();
      await fake.stop();
    }
  });
});
