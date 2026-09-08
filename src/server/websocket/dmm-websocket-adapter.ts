import {
  DmmAcquisitionRate,
  DmmControlKind,
  DmmMeasurementFunction,
  DmmRangeMode,
  type DmmControlChange,
  type DmmRange,
} from "../../shared/dmm-types.js";
import { SupportedInstrument } from "../../shared/instrument-types.js";
import {
  MessageType,
  PROTOCOL_VERSION,
  type ServerJsonMessage,
} from "../../shared/websocket-protocol.js";
import type { DmmApplicationService } from "../dmm/dmm-service.js";
import {
  DmmConnectionKind,
  type DmmConnection,
} from "../instruments/instrument-connection.js";
import type {
  WebSocketAdapterHost,
  WebSocketInstrumentAdapter,
  WebSocketSession,
} from "./websocket-adapter.js";
import {
  isRecord,
  readInstrument,
  readPositiveFiniteNumber,
  readRequestId,
} from "./websocket-validation.js";

export class DmmWebSocketAdapter implements WebSocketInstrumentAdapter {
  public readonly instrument = SupportedInstrument.Dm858e;

  private host: WebSocketAdapterHost | null = null;
  private connection: DmmConnection;
  private connectionRevision = 0;
  private unsubscribeServices: Array<() => void> = [];

  public constructor(private readonly dmmService: DmmApplicationService) {
    this.connection = dmmService.getConnection();
  }

  public attach(host: WebSocketAdapterHost): void {
    if (this.host !== null) {
      throw new Error("DMM WebSocket adapter is already attached");
    }
    this.host = host;
    this.unsubscribeServices = [
      this.dmmService.subscribeConnection((connection) => {
        this.connection = connection;
        this.connectionRevision += 1;
        host.broadcastJson(this.instrument, this.lifecycleMessage(connection));
      }),
      this.dmmService.subscribeState((state) => {
        if (this.connection.kind === DmmConnectionKind.Connected) {
          this.connection = { ...this.connection, state };
        }
        host.broadcastJson(this.instrument, {
          type: MessageType.DmmState,
          state,
        });
      }),
      this.dmmService.subscribeSnapshot((snapshot) => {
        host.broadcastJson(this.instrument, {
          type: MessageType.DmmSnapshot,
          snapshot,
        });
      }),
    ];
  }

  public detach(): void {
    for (const unsubscribe of this.unsubscribeServices) {
      unsubscribe();
    }
    this.unsubscribeServices = [];
    this.host = null;
  }

  public async tryDispatch(
    session: WebSocketSession,
    message: Record<string, unknown>,
  ): Promise<boolean> {
    switch (message.type) {
      case MessageType.DmmControlSet: {
        const requestId = readRequestId(message.requestId);
        const control = readDmmControl(message.control);
        const host = this.requireHost();
        host.requireSubscribed(session, this.instrument);
        const revision = this.connectionRevision;
        await this.dmmService.setControl(control);
        this.requireConnectionRevision(revision);
        host.sendCompleted(session, requestId);
        return true;
      }

      case MessageType.ScpiExecute: {
        const instrument = readInstrument(message.instrument);
        if (instrument !== this.instrument) {
          return false;
        }
        if (typeof message.command !== "string") {
          throw new Error("command must be a string");
        }
        const requestId = readRequestId(message.requestId);
        const host = this.requireHost();
        host.requireSubscribed(session, this.instrument);
        const revision = this.connectionRevision;
        const response = await this.dmmService.executeRawScpi(message.command);
        this.requireConnectionRevision(revision);
        host.sendJson(session, {
          type: MessageType.ScpiResult,
          requestId,
          response,
        });
        return true;
      }

      default:
        return false;
    }
  }

  public sendLifecycle(session: WebSocketSession): void {
    this.requireHost().sendJson(session, this.lifecycleMessage(this.connection));
  }

  public sendDisconnected(session: WebSocketSession, reason: string): void {
    this.requireHost().sendJson(session, {
      type: MessageType.DmmDisconnected,
      reason,
    });
  }

  public sessionUnsubscribed(_session: WebSocketSession): void {
    // DMM has no per-browser transport state in this stream.
  }

  public transportAvailable(_session: WebSocketSession): void {
    // DMM publishes JSON only.
  }

  private lifecycleMessage(connection: DmmConnection): ServerJsonMessage {
    if (connection.kind === DmmConnectionKind.Disconnected) {
      return {
        type: MessageType.DmmDisconnected,
        reason: connection.reason,
      };
    }

    return {
      type: MessageType.DmmConnected,
      protocolVersion: PROTOCOL_VERSION,
      info: connection.info,
      state: connection.state,
    };
  }

  private requireConnectionRevision(revision: number): void {
    if (revision !== this.connectionRevision) {
      throw new Error("DMM connection changed while request was in flight");
    }
  }

  private requireHost(): WebSocketAdapterHost {
    if (this.host === null) {
      throw new Error("DMM WebSocket adapter is not attached");
    }
    return this.host;
  }
}

function readDmmFunction(value: unknown): DmmMeasurementFunction {
  switch (value) {
    case DmmMeasurementFunction.DcVoltage:
    case DmmMeasurementFunction.AcVoltage:
    case DmmMeasurementFunction.DcCurrent:
    case DmmMeasurementFunction.AcCurrent:
    case DmmMeasurementFunction.Resistance2Wire:
    case DmmMeasurementFunction.Resistance4Wire:
    case DmmMeasurementFunction.Continuity:
    case DmmMeasurementFunction.Diode:
    case DmmMeasurementFunction.Frequency:
    case DmmMeasurementFunction.Period:
    case DmmMeasurementFunction.Capacitance:
    case DmmMeasurementFunction.Temperature:
      return value;
    default:
      throw new Error("Invalid DMM measurement function");
  }
}

function readDmmRange(value: unknown): DmmRange {
  if (!isRecord(value)) {
    throw new Error("DMM range must be an object");
  }

  switch (value.mode) {
    case DmmRangeMode.Auto:
      return { mode: DmmRangeMode.Auto };
    case DmmRangeMode.Fixed:
      return {
        mode: DmmRangeMode.Fixed,
        value: readPositiveFiniteNumber(value.value, "DMM fixed range"),
      };
    default:
      throw new Error("Invalid DMM range mode");
  }
}

function readDmmAcquisitionRate(value: unknown): DmmAcquisitionRate {
  switch (value) {
    case DmmAcquisitionRate.Slow:
    case DmmAcquisitionRate.Medium:
    case DmmAcquisitionRate.Fast:
      return value;
    default:
      throw new Error("Invalid DMM acquisition rate");
  }
}

function readDmmControl(value: unknown): DmmControlChange {
  if (!isRecord(value)) {
    throw new Error("DMM control must be an object");
  }

  switch (value.kind) {
    case DmmControlKind.Function:
      return {
        kind: DmmControlKind.Function,
        value: readDmmFunction(value.value),
      };
    case DmmControlKind.Range:
      return {
        kind: DmmControlKind.Range,
        function: readDmmFunction(value.function),
        value: readDmmRange(value.value),
      };
    case DmmControlKind.AcquisitionRate:
      return {
        kind: DmmControlKind.AcquisitionRate,
        function: readDmmFunction(value.function),
        value: readDmmAcquisitionRate(value.value),
      };
    default:
      throw new Error("Unknown DMM control kind");
  }
}
