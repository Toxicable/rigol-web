import type { ReactNode } from "react";
import { NavLink, useInRouterContext } from "react-router-dom";

interface InstrumentHeaderProps {
  children?: ReactNode;
}

export function InstrumentHeader({ children }: InstrumentHeaderProps) {
  const inRouter = useInRouterContext();

  return (
    <header className="instrument-shell">
      <strong>Rigol Web</strong>
      <nav className="instrument-switcher" aria-label="Instrument">
        {inRouter ? (
          <>
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
          </>
        ) : (
          <>
            <a className="instrument-link" href="/">DHO804</a>
            <a className="instrument-link" href="/dm858e">DM858E</a>
          </>
        )}
      </nav>
      {children}
    </header>
  );
}
