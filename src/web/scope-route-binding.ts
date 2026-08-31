import { SupportedInstrument } from "../shared/instrument-types.js";
import type { ScopeWebSocketClient } from "./websocket-client.js";

export type ScopeLifecycleClient = Pick<
  ScopeWebSocketClient,
  "subscribeInstrument" | "unsubscribeInstrument"
>;

export function bindScopeRoute(client: ScopeLifecycleClient): () => void {
  client.subscribeInstrument(SupportedInstrument.Dho804);
  return () => client.unsubscribeInstrument(SupportedInstrument.Dho804);
}
