import { useState, type ReactNode } from "react";
import { NavLink, useInRouterContext } from "react-router-dom";

import { copyViewportScreenshot } from "../copy-screenshot.js";

interface InstrumentHeaderProps {
  children?: ReactNode;
}

export function InstrumentHeader({ children }: InstrumentHeaderProps) {
  const inRouter = useInRouterContext();
  const [copyingScreenshot, setCopyingScreenshot] = useState(false);
  const [screenshotCopied, setScreenshotCopied] = useState(false);
  const [screenshotError, setScreenshotError] = useState<string | null>(null);

  const copyScreenshot = async () => {
    setCopyingScreenshot(true);
    setScreenshotCopied(false);
    setScreenshotError(null);
    try {
      await copyViewportScreenshot();
      setScreenshotCopied(true);
      window.setTimeout(() => setScreenshotCopied(false), 1500);
    } catch (error) {
      console.error("Copy Screenshot failed", error);
      const detail = error instanceof Error
        ? `${error.name}: ${error.message}`
        : String(error);
      setScreenshotError(detail);
    } finally {
      setCopyingScreenshot(false);
    }
  };

  return (
    <>
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
        <div className="screenshot-copy-control" data-screenshot-exclude="true">
          {screenshotError !== null ? (
            <span
              className="screenshot-copy-error"
              title={screenshotError}
              style={{ maxWidth: "34rem", whiteSpace: "normal" }}
            >
              {screenshotError}
            </span>
          ) : null}
          <button
            type="button"
            disabled={copyingScreenshot}
            onClick={() => void copyScreenshot()}
            title={screenshotError ?? "Copy the currently rendered Rigol Web viewport to the clipboard as PNG"}
          >
            {copyingScreenshot ? "Copying…" : "Copy Screenshot"}
          </button>
        </div>
      </header>
      {screenshotCopied ? (
        <div
          role="status"
          aria-live="polite"
          data-screenshot-exclude="true"
          style={{
            position: "fixed",
            right: "1rem",
            bottom: "1rem",
            zIndex: 1000,
            padding: "0.55rem 0.8rem",
            border: "1px solid #47515c",
            borderRadius: "6px",
            background: "#171b20",
            color: "#e8edf2",
            boxShadow: "0 4px 18px rgb(0 0 0 / 40%)",
            fontSize: "0.85rem",
            pointerEvents: "none",
          }}
        >
          Screenshot copied
        </div>
      ) : null}
    </>
  );
}
