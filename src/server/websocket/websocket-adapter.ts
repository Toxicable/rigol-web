import type { SupportedInstrument } from "../../shared/instrument-types.js";
import type { ServerJsonMessage } from "../../shared/websocket-protocol.js";

export interface WebSocketSession {
  readonly id: number;
}

export type BinarySendCallback = (error: Error | undefined) => void;

export interface WebSocketAdapterHost {
  requireSubscribed(session: WebSocketSession, instrument: SupportedInstrument): void;
  isOpen(session: WebSocketSession): boolean;
  isBackpressured(session: WebSocketSession): boolean;
  sendJson(session: WebSocketSession, message: ServerJsonMessage): void;
  sendBinary(
    session: WebSocketSession,
    frame: Uint8Array,
    callback?: BinarySendCallback,
  ): void;
  sendCompleted(session: WebSocketSession, requestId: number): void;
  sendFailure(session: WebSocketSession, requestId: number, error: unknown): void;
  broadcastJson(instrument: SupportedInstrument, message: ServerJsonMessage): void;
  forEachSubscribed(
    instrument: SupportedInstrument,
    callback: (session: WebSocketSession) => void,
  ): void;
}

export interface WebSocketInstrumentAdapter {
  readonly instrument: SupportedInstrument;
  attach(host: WebSocketAdapterHost): void;
  detach(): void;
  tryDispatch(session: WebSocketSession, message: Record<string, unknown>): Promise<boolean>;
  sendInitialPublications(session: WebSocketSession): void;
  sessionUnsubscribed(session: WebSocketSession): void;
  transportAvailable(session: WebSocketSession): void;
}
