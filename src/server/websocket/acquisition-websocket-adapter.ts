import { AcquisitionInitiatorKind } from "../../shared/acquisition-types.js";
import {
  MessageType,
  type AcquisitionOperationGetMessage,
  type AcquisitionOperationListMessage,
  type AcquisitionOperationStartMessage,
  type AcquisitionOperationStopMessage,
} from "../../shared/websocket-protocol.js";
import type { AcquisitionApplicationService } from "../acquisition/acquisition-service.js";
import type {
  WebSocketAdapterHost,
  WebSocketApplicationAdapter,
  WebSocketSession,
} from "./websocket-adapter.js";
import {
  readPositiveInteger,
  readRequestId,
} from "./websocket-validation.js";

const MAX_LABEL_LENGTH = 120;

export class AcquisitionWebSocketAdapter implements WebSocketApplicationAdapter {
  private host: WebSocketAdapterHost | null = null;

  public constructor(private readonly service: AcquisitionApplicationService) {}

  public attach(host: WebSocketAdapterHost): void {
    if (this.host !== null) {
      throw new Error("Acquisition WebSocket adapter is already attached");
    }
    this.host = host;
  }

  public detach(): void {
    this.host = null;
  }

  public async tryDispatch(
    session: WebSocketSession,
    message: Record<string, unknown>,
  ): Promise<boolean> {
    switch (message.type) {
      case MessageType.AcquisitionOperationStart:
        this.start(session, readStart(message));
        return true;
      case MessageType.AcquisitionOperationStop:
        this.stop(session, readStop(message));
        return true;
      case MessageType.AcquisitionOperationGet:
        this.get(session, readGet(message));
        return true;
      case MessageType.AcquisitionOperationList:
        this.list(session, readList(message));
        return true;
      default:
        return false;
    }
  }

  private start(session: WebSocketSession, message: AcquisitionOperationStartMessage): void {
    const operation = this.service.start(message.label, {
      kind: AcquisitionInitiatorKind.Browser,
      sessionId: session.id,
    });
    this.requireHost().sendJson(session, {
      type: MessageType.AcquisitionOperationResult,
      requestId: message.requestId,
      operation,
    });
  }

  private stop(session: WebSocketSession, message: AcquisitionOperationStopMessage): void {
    const operation = this.service.stop(message.operationId);
    this.requireHost().sendJson(session, {
      type: MessageType.AcquisitionOperationResult,
      requestId: message.requestId,
      operation,
    });
  }

  private get(session: WebSocketSession, message: AcquisitionOperationGetMessage): void {
    const operation = this.service.get(message.operationId);
    this.requireHost().sendJson(session, {
      type: MessageType.AcquisitionOperationResult,
      requestId: message.requestId,
      operation,
    });
  }

  private list(session: WebSocketSession, message: AcquisitionOperationListMessage): void {
    this.requireHost().sendJson(session, {
      type: MessageType.AcquisitionOperationListResult,
      requestId: message.requestId,
      operations: [...this.service.list()],
    });
  }

  private requireHost(): WebSocketAdapterHost {
    if (this.host === null) {
      throw new Error("Acquisition WebSocket adapter is not attached");
    }
    return this.host;
  }
}

function readStart(message: Record<string, unknown>): AcquisitionOperationStartMessage {
  return {
    type: MessageType.AcquisitionOperationStart,
    requestId: readRequestId(message.requestId),
    label: readLabel(message.label),
  };
}

function readStop(message: Record<string, unknown>): AcquisitionOperationStopMessage {
  return {
    type: MessageType.AcquisitionOperationStop,
    requestId: readRequestId(message.requestId),
    operationId: readPositiveInteger(message.operationId, "operationId"),
  };
}

function readGet(message: Record<string, unknown>): AcquisitionOperationGetMessage {
  return {
    type: MessageType.AcquisitionOperationGet,
    requestId: readRequestId(message.requestId),
    operationId: readPositiveInteger(message.operationId, "operationId"),
  };
}

function readList(message: Record<string, unknown>): AcquisitionOperationListMessage {
  return {
    type: MessageType.AcquisitionOperationList,
    requestId: readRequestId(message.requestId),
  };
}

function readLabel(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("Acquisition label must be a string");
  }
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error("Acquisition label must not be empty");
  }
  if (normalized.length > MAX_LABEL_LENGTH) {
    throw new Error(`Acquisition label must be at most ${MAX_LABEL_LENGTH} characters`);
  }
  return normalized;
}
