import { useEffect, useMemo, useRef } from "react";
import { Route, Routes } from "react-router-dom";

import { AppConnection } from "./app-connection.js";
import { DmmBinding } from "./dmm/dmm-binding.js";
import { DmmRoute } from "./dmm/dmm-route.js";
import { ScopeBinding } from "./scope-binding.js";
import { ScopeRoute } from "./scope-route.js";
import { WaveformController } from "./waveform/waveform-controller.js";

export function App() {
  const scopeBindingRef = useRef<ScopeBinding | null>(null);
  const connection = useMemo(() => new AppConnection(), []);
  const controller = useMemo(
    () =>
      new WaveformController((request) => {
        const binding = scopeBindingRef.current;
        if (binding === null) {
          throw new Error("Waveform viewport requested before scope binding initialization");
        }
        return binding.requestViewport(request);
      }),
    [],
  );
  const scopeBinding = useMemo(() => {
    const created = new ScopeBinding(connection, controller);
    scopeBindingRef.current = created;
    return created;
  }, [connection, controller]);
  const dmmBinding = useMemo(() => new DmmBinding(connection), [connection]);

  useEffect(() => {
    connection.connect();
    return () => {
      scopeBinding.dispose();
      dmmBinding.dispose();
      connection.dispose();
    };
  }, [connection, dmmBinding, scopeBinding]);

  return (
    <main className="app-shell">
      <Routes>
        <Route path="/" element={<ScopeRoute binding={scopeBinding} controller={controller} />} />
        <Route path="/dm858e" element={<DmmRoute binding={dmmBinding} />} />
      </Routes>
    </main>
  );
}
