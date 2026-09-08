import type { SupportedInstrument } from "../../shared/instrument-types.js";
import type { ServerJsonMessage } from "../../shared/websocket-protocol.js";

export interface WebSocketClientSession {
  readonly id: number;
  readonly bufferedAmount: number;
  readonly isOpen: boolean;
  isSubscribed(instrument: SupportedInstrument): boolean;
  sendJson(message: ServerJsonMessage): void;
  sendBinary(frame: Uint8Array, afterSend?: (error: Error | undefined) => void): void;
  complete(requestId: number): void;
  fail(requestId: number, error: unknown): void;
  onSendComplete(listener: () => void): () => void;
}

export interface WebSocketPublicationSink {
  forEachSubscriber(
    instrument: SupportedInstrument,
    callback: (client: WebSocketClientSession) => void,
  ): void;
}
