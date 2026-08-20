import { useEffect, useMemo, useRef } from "react";

import { BrowserConnectionKind, useScopeStore } from "./scope-store.js";
import { ScopeWebSocketClient } from "./websocket-client.js";
import { WaveformController } from "./waveform/waveform-controller.js";
import { WaveformPlot } from "./waveform/waveform-plot.js";
import { ChannelControls } from "./components/channel-controls.js";
import { HorizontalControls } from "./components/horizontal-controls.js";
import { MeasurementPanel } from "./components/measurement-panel.js";
import { ScopeToolbar } from "./components/scope-toolbar.js";
import { ScpiConsole } from "./components/scpi-console.js";
import { TriggerControls } from "./components/trigger-controls.js";

export function App() {
  const connection = useScopeStore((state) => state.connection);
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
      <ScopeToolbar client={client} controller={controller} />
      {connection.kind === BrowserConnectionKind.ScopeConnected ? (
        <>
          <div className="scope-layout">
            <section className="waveform-panel">
              <WaveformPlot
                scope={connection.scope}
                controller={controller}
                client={client}
              />
            </section>
            <aside className="control-stack">
              <ChannelControls channels={connection.scope.channels} client={client} />
              <HorizontalControls scope={connection.scope} client={client} />
              <TriggerControls scope={connection.scope} client={client} />
            </aside>
          </div>
          <div className="bottom-grid">
            <MeasurementPanel scope={connection.scope} client={client} />
            <ScpiConsole client={client} />
          </div>
        </>
      ) : (
        <section className="empty-state">
          <h1>Rigol Web</h1>
          <p>Waiting for the scope connection.</p>
        </section>
      )}
    </main>
  );
}
