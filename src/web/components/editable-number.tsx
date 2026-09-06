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
  return Number.isFinite(parsed) ? parsed : null;
}

interface EditableNumberInputProps {
  value: number;
  onCommit: (value: number) => void;
  validate?: (value: number) => boolean;
  ariaLabel?: string;
}

export function EditableNumberInput({
  value,
  onCommit,
  validate,
  ariaLabel,
}: EditableNumberInputProps) {
  const [draft, setDraft] = useState(formatEditableNumber(value));
  const [editing, setEditing] = useState(false);
  const cancelRef = useRef(false);

  useEffect(() => {
    if (!editing) {
      setDraft(formatEditableNumber(value));
    }
  }, [editing, value]);

  const reset = (): void => {
    setDraft(formatEditableNumber(value));
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
    setDraft(formatEditableNumber(parsed));
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
