import { useEffect } from "react";

import { ChannelControls } from "./components/channel-controls.js";
import { HorizontalControls } from "./components/horizontal-controls.js";
import { MeasurementOverlay } from "./components/measurement-overlay.js";
import { MeasurementPanel } from "./components/measurement-panel.js";
import { ScopeToolbar } from "./components/scope-toolbar.js";
import { TriggerControls } from "./components/trigger-controls.js";
import { bindScopeRoute } from "./scope-route-binding.js";
import { BrowserConnectionKind, useScopeStore } from "./scope-store.js";
import type { ScopeWebSocketClient } from "./websocket-client.js";
import type { WaveformController } from "./waveform/waveform-controller.js";
import { WaveformPlot } from "./waveform/waveform-plot.js";

interface ScopeRouteProps {
  client: ScopeWebSocketClient;
  controller: WaveformController;
}

export function ScopeRoute({ client, controller }: ScopeRouteProps) {
  const connection = useScopeStore((state) => state.connection);

  useEffect(() => bindScopeRoute(client), [client]);

  useEffect(() => {
    if (connection.kind === BrowserConnectionKind.ScopeConnected) {
      controller.setLiveChannels(connection.scope.channels);
    }
  }, [connection, controller]);

  return (
    <section className="scope-route">
      <ScopeToolbar client={client} />
      {connection.kind === BrowserConnectionKind.ScopeConnected ? (
        <>
          <div className="scope-layout">
            <section className="waveform-panel">
              <WaveformPlot
                scope={connection.scope}
                controller={controller}
                client={client}
              />
              <MeasurementOverlay scope={connection.scope} />
            </section>
            <aside className="control-stack">
              <ChannelControls channels={connection.scope.channels} client={client} />
              <HorizontalControls scope={connection.scope} client={client} />
              <TriggerControls scope={connection.scope} client={client} />
            </aside>
          </div>
          <div className="bottom-grid">
            <MeasurementPanel scope={connection.scope} client={client} />
          </div>
        </>
      ) : (
        <section className="empty-state">
          <h1>DHO804</h1>
          <p>Waiting for the scope connection.</p>
        </section>
      )}
    </section>
  );
}
