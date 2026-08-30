import { useState, type ChangeEvent, type KeyboardEvent } from "react";

import type { SupportedInstrument } from "../../shared/instrument-types.js";
import type { ScopeWebSocketClient } from "../websocket-client.js";

interface ScpiEntry {
  id: number;
  command: string;
  response: string;
  failed: boolean;
}

interface ScpiConsoleProps {
  client: ScopeWebSocketClient;
  instrument: SupportedInstrument;
  placeholder?: string;
}

export function ScpiConsole({
  client,
  instrument,
  placeholder = ":MEASure:VPP? CHANnel1",
}: ScpiConsoleProps) {
  const [command, setCommand] = useState("");
  const [history, setHistory] = useState<ScpiEntry[]>([]);
  const [nextId, setNextId] = useState(0);
  const [busy, setBusy] = useState(false);

  const execute = async () => {
    const trimmed = command.trim();
    if (trimmed.length === 0 || busy) {
      return;
    }
    setBusy(true);
    setCommand("");
    const id = nextId;
    setNextId(id + 1);
    try {
      const response = await client.executeScpi(instrument, trimmed);
      setHistory((current) => [...current, { id, command: trimmed, response, failed: false }]);
    } catch (error) {
      setHistory((current) => [
        ...current,
        {
          id,
          command: trimmed,
          response: error instanceof Error ? error.message : String(error),
          failed: true,
        },
      ]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel scpi-panel">
      <h2>SCPI</h2>
      <div className="scpi-input-row">
        <input
          type="text"
          value={command}
          placeholder={placeholder}
          onChange={(event: ChangeEvent<HTMLInputElement>) => setCommand(event.target.value)}
          onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
            if (event.key === "Enter") {
              void execute();
            }
          }}
        />
        <button type="button" disabled={busy} onClick={() => void execute()}>Execute</button>
      </div>
      <div className="scpi-history">
        {history.map((entry) => (
          <div className={entry.failed ? "scpi-entry failed" : "scpi-entry"} key={entry.id}>
            <code>&gt; {entry.command}</code>
            <pre>{entry.response === "" ? "(completed, no response)" : entry.response}</pre>
          </div>
        ))}
      </div>
    </section>
  );
}
