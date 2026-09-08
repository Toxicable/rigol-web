import { useEffect } from "react";

import { AppTransportKind, useAppTransportStore } from "./app-transport-store.js";
import { ChannelControls } from "./components/channel-controls.js";
import { HorizontalControls } from "./components/horizontal-controls.js";
import { MeasurementOverlay } from "./components/measurement-overlay.js";
import { MeasurementPanel } from "./components/measurement-panel.js";
import { ScopeToolbar } from "./components/scope-toolbar.js";
import { TriggerControls } from "./components/trigger-controls.js";
import type { ScopeBinding } from "./scope-binding.js";
import { bindScopeRoute } from "./scope-route-binding.js";
import { BrowserConnectionKind, useScopeStore } from "./scope-store.js";
import type { WaveformController } from "./waveform/waveform-controller.js";
import { WaveformPlot } from "./waveform/waveform-plot.js";

interface ScopeRouteProps {
  binding: ScopeBinding;
  controller: WaveformController;
}

export function ScopeRoute({ binding, controller }: ScopeRouteProps) {
  const transport = useAppTransportStore((state) => state.transport);
  const connection = useScopeStore((state) => state.connection);

  useEffect(() => bindScopeRoute(binding), [binding]);

  useEffect(() => {
    if (
      transport.kind === AppTransportKind.Connected &&
      connection.kind === BrowserConnectionKind.ScopeConnected
    ) {
      controller.setLiveChannels(connection.scope.channels);
    }
  }, [connection, controller, transport.kind]);

  const connected =
    transport.kind === AppTransportKind.Connected &&
    connection.kind === BrowserConnectionKind.ScopeConnected;

  return (
    <section className="scope-route">
      <ScopeToolbar client={binding} />
      {connected ? (
        <div className="scope-layout">
          <div className="waveform-column">
            <section className="waveform-panel">
              <WaveformPlot
                scope={connection.scope}
                controller={controller}
                client={binding}
              />
              <MeasurementOverlay scope={connection.scope} />
            </section>
            <MeasurementPanel client={binding} controller={controller} />
          </div>
          <aside className="control-stack">
            <ChannelControls channels={connection.scope.channels} client={binding} />
            <HorizontalControls scope={connection.scope} client={binding} />
            <TriggerControls scope={connection.scope} client={binding} />
          </aside>
        </div>
      ) : (
        <section className="empty-state">
          <h1>DHO804</h1>
          <p>{scopeConnectionDetail(transport, connection)}</p>
        </section>
      )}
    </section>
  );
}

function scopeConnectionDetail(
  transport: ReturnType<typeof useAppTransportStore.getState>["transport"],
  connection: ReturnType<typeof useScopeStore.getState>["connection"],
): string {
  switch (transport.kind) {
    case AppTransportKind.Connecting:
      return "Connecting to Rigol Web.";
    case AppTransportKind.Disconnected:
      return `Rigol Web transport disconnected: ${transport.reason}`;
    case AppTransportKind.Connected:
      break;
  }

  switch (connection.kind) {
    case BrowserConnectionKind.AwaitingInstrument:
      return "Waiting for the DHO804 runtime.";
    case BrowserConnectionKind.ScopeDisconnected:
      return connection.reason;
    case BrowserConnectionKind.ScopeConnected:
      return `${connection.info.model} connected.`;
  }
}
