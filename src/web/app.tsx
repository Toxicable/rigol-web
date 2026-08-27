import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";

import { DmmRoute } from "./dmm/dmm-route.js";
import { ScopeRoute } from "./scope-route.js";
import { ScopeWebSocketClient } from "./websocket-client.js";
import { WaveformController } from "./waveform/waveform-controller.js";

type AppRoute = "/" | "/dm858e";

function currentRoute(): AppRoute {
  return window.location.pathname === "/dm858e" || window.location.pathname === "/dm858e/"
    ? "/dm858e"
    : "/";
}

export function App() {
  const [route, setRoute] = useState<AppRoute>(currentRoute);
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

  useEffect(() => {
    const onPopState = () => setRoute(currentRoute());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const navigate = (event: ReactMouseEvent<HTMLAnchorElement>, nextRoute: AppRoute) => {
    if (
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }
    event.preventDefault();
    if (nextRoute === route) {
      return;
    }
    window.history.pushState(null, "", nextRoute);
    setRoute(nextRoute);
  };

  return (
    <main className="app-shell">
      <header className="instrument-shell">
        <strong>Rigol Web</strong>
        <nav className="instrument-switcher" aria-label="Instrument">
          <a
            href="/"
            className={route === "/" ? "instrument-link active" : "instrument-link"}
            onClick={(event) => navigate(event, "/")}
          >
            DHO804
          </a>
          <a
            href="/dm858e"
            className={route === "/dm858e" ? "instrument-link active" : "instrument-link"}
            onClick={(event) => navigate(event, "/dm858e")}
          >
            DM858E
          </a>
        </nav>
      </header>
      {route === "/dm858e" ? (
        <DmmRoute client={client} />
      ) : (
        <ScopeRoute client={client} controller={controller} />
      )}
    </main>
  );
}
