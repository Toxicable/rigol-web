import { useEffect, useMemo, useRef } from "react";
import { Route, Routes } from "react-router-dom";

import { AppConnection } from "./app-connection.js";
import { DmmActions } from "./dmm/dmm-actions.js";
import { DmmBinding } from "./dmm/dmm-binding.js";
import { DmmRoute } from "./dmm/dmm-route.js";
import { Ppk2Actions } from "./ppk2/ppk2-actions.js";
import { Ppk2Binding } from "./ppk2/ppk2-binding.js";
import { Ppk2Route } from "./ppk2/ppk2-route.js";
import { ScopeActions } from "./scope-actions.js";
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
  const ppk2Binding = useMemo(() => new Ppk2Binding(connection), [connection]);
  const scopeActions = useMemo(() => new ScopeActions(scopeBinding), [scopeBinding]);
  const dmmActions = useMemo(() => new DmmActions(dmmBinding), [dmmBinding]);
  const ppk2Actions = useMemo(() => new Ppk2Actions(ppk2Binding), [ppk2Binding]);

  useEffect(() => {
    connection.connect();
    return () => {
      scopeActions.dispose();
      scopeBinding.dispose();
      dmmBinding.dispose();
      ppk2Binding.dispose();
      connection.dispose();
    };
  }, [connection, dmmBinding, ppk2Binding, scopeActions, scopeBinding]);

  return (
    <main className="app-shell">
      <Routes>
        <Route
          path="/"
          element={(
            <ScopeRoute
              binding={scopeBinding}
              actions={scopeActions}
              controller={controller}
            />
          )}
        />
        <Route
          path="/dm858e"
          element={<DmmRoute binding={dmmBinding} actions={dmmActions} />}
        />
        <Route
          path="/ppk2"
          element={<Ppk2Route binding={ppk2Binding} actions={ppk2Actions} />}
        />
      </Routes>
    </main>
  );
}
