import { useEffect } from "react";

import { SupportedInstrument } from "../shared/instrument-types.js";
import { ChannelControls } from "./components/channel-controls.js";
import { HorizontalControls } from "./components/horizontal-controls.js";
import { MeasurementPanel } from "./components/measurement-panel.js";
import { ScpiConsole } from "./components/scpi-console.js";
import { ScopeToolbar } from "./components/scope-toolbar.js";
import { TriggerControls } from "./components/trigger-controls.js";
import { BrowserConnectionKind, useScopeStore } from "./scope-store.js";
import type { ScopeWebSocketClient } from "./websocket-client.js";
import type { WaveformController } from "./waveform/waveform-controller.js";
import { WaveformPlot } from "./waveform/waveform-plot.js";

interface ScopeRouteProps {
  client: ScopeWebSocketClient;
  controller: WaveformController;
}

export type ScopeLifecycleClient = Pick<
  ScopeWebSocketClient,
  "subscribeInstrument" | "unsubscribeInstrument"
>;

export function bindScopeRoute(client: ScopeLifecycleClient): () => void {
  client.subscribeInstrument(SupportedInstrument.Dho804);
  return () => client.unsubscribeInstrument(SupportedInstrument.Dho804);
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
    <>
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
            </section>
            <aside className="control-stack">
              <ChannelControls channels={connection.scope.channels} client={client} />
              <HorizontalControls scope={connection.scope} client={client} />
              <TriggerControls scope={connection.scope} client={client} />
            </aside>
          </div>
          <div className="bottom-grid">
            <MeasurementPanel scope={connection.scope} client={client} />
            <ScpiConsole client={client} instrument={SupportedInstrument.Dho804} />
          </div>
        </>
      ) : (
        <section className="empty-state">
          <h1>DHO804</h1>
          <p>Waiting for the scope connection.</p>
        </section>
      )}
    </>
  );
}
