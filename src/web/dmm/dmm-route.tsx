import { useEffect, useState } from "react";

import { SupportedInstrument } from "../../shared/instrument-types.js";
import { MessageType } from "../../shared/websocket-protocol.js";
import type { ScopeWebSocketClient } from "../websocket-client.js";

interface DmmRouteProps {
  client: ScopeWebSocketClient;
}

export function DmmRoute({ client }: DmmRouteProps) {
  const [status, setStatus] = useState("Waiting for the DM858E runtime.");

  useEffect(() => {
    const stopListening = client.onDmmMessage((message) => {
      switch (message.type) {
        case MessageType.DmmConnected:
          setStatus(`${message.info.model} connected.`);
          return;
        case MessageType.DmmDisconnected:
          setStatus(message.reason);
          return;
        case MessageType.DmmState:
        case MessageType.DmmReading:
          return;
      }
    });
    client.subscribeInstrument(SupportedInstrument.Dm858e);

    return () => {
      client.unsubscribeInstrument(SupportedInstrument.Dm858e);
      stopListening();
    };
  }, [client]);

  return (
    <section className="empty-state dmm-route-shell">
      <div>
        <h1>DM858E</h1>
        <p>{status}</p>
        <p className="muted">The DMM route and protocol are ready for the backend and frontend workstreams.</p>
      </div>
    </section>
  );
}
