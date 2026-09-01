import type { ReactNode } from "react";
import { NavLink } from "react-router-dom";

interface InstrumentHeaderProps {
  children?: ReactNode;
}

export function InstrumentHeader({ children }: InstrumentHeaderProps) {
  return (
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
      {children}
    </header>
  );
}
