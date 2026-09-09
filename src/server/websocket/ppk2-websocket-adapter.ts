import { AcquisitionInitiatorKind } from "../../shared/acquisition-types.js";
import { SupportedInstrument } from "../../shared/instrument-types.js";
import { Ppk2ConnectionKind, type Ppk2Connection } from "../../shared/ppk2-types.js";
import {
  MessageType,
  PROTOCOL_VERSION,
  type ServerJsonMessage,
} from "../../shared/websocket-protocol.js";
import type { Ppk2ApplicationService } from "../ppk2/ppk2-service.js";
import type {
  WebSocketAdapterHost,
  WebSocketInstrumentAdapter,
  WebSocketSession,
} from "./websocket-adapter.js";
import {
  readNonNegativeInteger,
  readPositiveInteger,
  readRequestId,
} from "./websocket-validation.js";

export class Ppk2WebSocketAdapter implements WebSocketInstrumentAdapter {
  public readonly instrument = SupportedInstrument.Ppk2;

  private host: WebSocketAdapterHost | null = null;
  private connection: Ppk2Connection;
  private unsubscribeServices: Array<() => void> = [];

  public constructor(private readonly service: Ppk2ApplicationService) {
    this.connection = service.getConnection();
  }

  public attach(host: WebSocketAdapterHost): void {
    if (this.host !== null) {
      throw new Error("PPK2 WebSocket adapter is already attached");
    }
    this.host = host;
    this.unsubscribeServices = [
      this.service.subscribeConnection((connection) => {
        this.connection = connection;
        host.broadcastJson(this.instrument, this.lifecycleMessage(connection));
      }),
      this.service.subscribeStats((stats) => {
        host.broadcastJson(this.instrument, {
          type: MessageType.Ppk2Stats,
          stats,
        });
      }),
      this.service.subscribeLive((buckets) => {
        const operation = this.service.getStats().operation;
        if (operation === null) {
          return;
        }
        host.broadcastJson(this.instrument, {
          type: MessageType.Ppk2Live,
          update: {
            operationId: operation.id,
            buckets: buckets.map((bucket) => ({ ...bucket })),
          },
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
      case MessageType.Ppk2CaptureStart: {
        const requestId = readRequestId(message.requestId);
        const host = this.requireHost();
        host.requireSubscribed(session, this.instrument);
        const operation = await this.service.startCapture({
          kind: AcquisitionInitiatorKind.Browser,
          sessionId: session.id,
        });
        host.sendJson(session, {
          type: MessageType.AcquisitionOperationResult,
          requestId,
          operation,
        });
        return true;
      }

      case MessageType.Ppk2CaptureStop: {
        const requestId = readRequestId(message.requestId);
        const operationId = readPositiveInteger(message.operationId, "PPK2 operationId");
        const host = this.requireHost();
        host.requireSubscribed(session, this.instrument);
        const operation = await this.service.stopCapture(operationId);
        host.sendJson(session, {
          type: MessageType.AcquisitionOperationResult,
          requestId,
          operation,
        });
        return true;
      }

      case MessageType.Ppk2ViewportRequest: {
        const requestId = readRequestId(message.requestId);
        const operationId = readPositiveInteger(message.operationId, "PPK2 operationId");
        const firstSequence = readNonNegativeInteger(
          message.firstSequence,
          "PPK2 viewport firstSequence",
        );
        const endSequenceExclusive = readNonNegativeInteger(
          message.endSequenceExclusive,
          "PPK2 viewport endSequenceExclusive",
        );
        const maxBuckets = readPositiveInteger(message.maxBuckets, "PPK2 viewport maxBuckets");
        const host = this.requireHost();
        host.requireSubscribed(session, this.instrument);
        const viewport = this.service.readViewport(
          operationId,
          firstSequence,
          endSequenceExclusive,
          maxBuckets,
        );
        host.sendJson(session, {
          type: MessageType.Ppk2ViewportResult,
          requestId,
          viewport,
        });
        return true;
      }

      default:
        return false;
    }
  }

  public sendInitialPublications(session: WebSocketSession): void {
    const host = this.requireHost();
    host.sendJson(session, this.lifecycleMessage(this.connection));
    host.sendJson(session, {
      type: MessageType.Ppk2Stats,
      stats: this.service.getStats(),
    });
  }

  public sessionUnsubscribed(_session: WebSocketSession): void {
    // PPK2 capture lifetime is server-owned, not a browser publication lease.
  }

  public transportAvailable(_session: WebSocketSession): void {
    // PPK2 browser publications are bounded JSON summaries, not the raw stream.
  }

  private lifecycleMessage(connection: Ppk2Connection): ServerJsonMessage {
    if (connection.kind === Ppk2ConnectionKind.Disconnected) {
      return {
        type: MessageType.Ppk2Disconnected,
        reason: connection.reason,
      };
    }
    return {
      type: MessageType.Ppk2Connected,
      protocolVersion: PROTOCOL_VERSION,
      info: connection.info,
    };
  }

  private requireHost(): WebSocketAdapterHost {
    if (this.host === null) {
      throw new Error("PPK2 WebSocket adapter is not attached");
    }
    return this.host;
  }
}
