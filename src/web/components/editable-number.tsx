import { useEffect, useRef, useState, type KeyboardEvent } from "react";

export function formatEditableNumber(value: number): string {
  if (!Number.isFinite(value)) {
    return "";
  }
  if (value === 0) {
    return "0";
  }
  return String(Number(value.toPrecision(6)));
}

export function parseEditableNumber(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const parsed = Number(trimmed);
  if (Number.isFinite(parsed)) return parsed;

  const match = trimmed.match(/^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*([pnumkMGTµ]?)\s*(?:[a-zA-Z/]+)?$/);
  if (match === null) return null;
  const mantissa = Number(match[1]);
  const multiplier: Record<string, number> = {
    p: 1e-12,
    n: 1e-9,
    u: 1e-6,
    m: 1e-3,
    k: 1e3,
    M: 1e6,
    G: 1e9,
    T: 1e12,
  };
  const suffix = match[2] ?? "";
  const factor = suffix === "µ" ? 1e-6 : multiplier[suffix] ?? 1;
  const result = mantissa * factor;
  return Number.isFinite(result) ? result : null;
}

interface EditableNumberInputProps {
  value: number;
  onCommit: (value: number) => void;
  validate?: (value: number) => boolean;
  ariaLabel?: string;
  formatValue?: (value: number) => string;
}

export function EditableNumberInput({
  value,
  onCommit,
  validate,
  ariaLabel,
  formatValue = formatEditableNumber,
}: EditableNumberInputProps) {
  const [draft, setDraft] = useState(formatEditableNumber(value));
  const [editing, setEditing] = useState(false);
  const cancelRef = useRef(false);

  useEffect(() => {
    if (!editing) {
      setDraft(formatValue(value));
    }
  }, [editing, formatValue, value]);

  const reset = (): void => {
    setDraft(formatValue(value));
    setEditing(false);
  };

  const commit = (): void => {
    if (cancelRef.current) {
      cancelRef.current = false;
      reset();
      return;
    }

    const parsed = parseEditableNumber(draft);
    if (parsed === null || (validate !== undefined && !validate(parsed))) {
      reset();
      return;
    }

    onCommit(parsed);
    setDraft(formatValue(parsed));
    setEditing(false);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "Enter") {
      event.currentTarget.blur();
      return;
    }
    if (event.key === "Escape") {
      cancelRef.current = true;
      event.currentTarget.blur();
    }
  };

  return (
    <input
      type="text"
      inputMode="decimal"
      value={draft}
      aria-label={ariaLabel}
      onFocus={() => setEditing(true)}
      onChange={(event) => setDraft(event.currentTarget.value)}
      onBlur={commit}
      onKeyDown={onKeyDown}
    />
  );
}
