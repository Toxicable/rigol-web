import { useEffect, useRef, type ReactNode } from "react";

interface FlyoutProps {
  open: boolean;
  onClose: () => void;
  className?: string;
  children: ReactNode;
}

export function Flyout({ open, onClose, className, children }: FlyoutProps) {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: PointerEvent) => {
      const root = rootRef.current;
      if (root !== null && !root.contains(event.target as Node)) onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose, open]);

  return <div ref={rootRef} className={className}>{children}</div>;
}
