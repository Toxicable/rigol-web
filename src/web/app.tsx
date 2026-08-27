import { useEffect, useMemo, useRef } from "react";
import { NavLink, Route, Routes } from "react-router-dom";

import { DmmRoute } from "./dmm/dmm-route.js";
import { ScopeRoute } from "./scope-route.js";
import { ScopeWebSocketClient } from "./websocket-client.js";
import { WaveformController } from "./waveform/waveform-controller.js";

export function App() {
  const clientRef = useRef<ScopeWebSocketClient | null>(null);
  const controller = useMemo(
    () =>
      new WaveformController((request) => {
        const currentClient = clientRef.current;
        if (currentClient === null) {
          throw new Error("Waveform viewport requested before WebSocket client initialization");
        }
        return currentClient.requestViewport(request);
      }),
    [],
  );
  const client = useMemo(() => {
    const created = new ScopeWebSocketClient(controller);
    clientRef.current = created;
    return created;
  }, [controller]);

  useEffect(() => {
    client.connect();
    return () => client.dispose();
  }, [client]);

  return (
    <main className="app-shell">
      <header className="instrument-shell">
        <strong>Rigol Web</strong>
        <nav className="instrument-switcher" aria-label="Instrument">
          <NavLink
            to="/"
            end
            className={({ isActive }) => isActive ? "instrument-link active" : "instrument-link"}
          >
            DHO804
          </NavLink>
          <NavLink
            to="/dm858e"
            className={({ isActive }) => isActive ? "instrument-link active" : "instrument-link"}
          >
            DM858E
          </NavLink>
        </nav>
      </header>
      <Routes>
        <Route path="/" element={<ScopeRoute client={client} controller={controller} />} />
        <Route path="/dm858e" element={<DmmRoute client={client} />} />
      </Routes>
    </main>
  );
}
