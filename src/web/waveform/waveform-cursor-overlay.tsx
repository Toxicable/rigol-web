import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type Dispatch,
  type PointerEvent,
} from "react";

import {
  WaveformSource,
  channelForWaveformSource,
  mathForWaveformSource,
  waveformSourceUnit,
  type ScopeState,
} from "../../shared/scope-types.js";
import {
  formatStableAmplitude,
  formatStableHertz,
  formatStableSeconds,
} from "../format-value.js";
import { DeepCaptureKind, useScopeStore } from "../scope-store.js";
import { waveformSourceAccent, waveformSourceLabel } from "../waveform-source-style.js";
import { WaveformDisplayMode, type WaveformController } from "./waveform-controller.js";
import {
  nearestWaveformPoint,
  type WaveformCursorAction,
  type WaveformCursorMarker,
  type WaveformCursorSlot,
  type WaveformCursorState,
} from "./waveform-cursors.js";

interface WaveformCursorOverlayProps {
  scope: ScopeState;
  controller: WaveformController;
  cursorState: WaveformCursorState;
  dispatchCursor: Dispatch<WaveformCursorAction>;
}

interface PlotRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface CursorPosition {
  left: number;
  top: number;
}

interface CursorCandidate extends CursorPosition {
  marker: WaveformCursorMarker;
}

interface DraggedCursor {
  slot: WaveformCursorSlot;
  pointerId: number;
}

const ALL_SOURCES = [
  WaveformSource.Ch1,
  WaveformSource.Ch2,
  WaveformSource.Ch3,
  WaveformSource.Ch4,
  WaveformSource.Math1,
  WaveformSource.Math2,
  WaveformSource.Math3,
  WaveformSource.Math4,
] as const;
const SNAP_RADIUS_PX = 56;

function sourceDomain(scope: ScopeState, source: WaveformSource): { min: number; max: number } | null {
  const channel = channelForWaveformSource(source);
  if (channel !== null) {
    const state = scope.channels[channel - 1];
    if (state === undefined || !(state.scale > 0)) return null;
    return {
      min: -state.offset - 4 * state.scale,
      max: -state.offset + 4 * state.scale,
    };
  }

  const math = mathForWaveformSource(source);
  if (math === null) return null;
  const state = scope.math[math - 1];
  if (
    state === undefined ||
    state.scale === null ||
    state.offset === null ||
    !(state.scale > 0)
  ) return null;
  return {
    min: -state.offset - 4 * state.scale,
    max: -state.offset + 4 * state.scale,
  };
}

function readPlotRect(overlay: HTMLDivElement): PlotRect | null {
  const plot = overlay.parentElement?.querySelector(".waveform-host .u-over");
  if (!(plot instanceof HTMLElement)) return null;
  const overlayBounds = overlay.getBoundingClientRect();
  const plotBounds = plot.getBoundingClientRect();
  if (!(plotBounds.width > 0) || !(plotBounds.height > 0)) return null;
  return {
    left: plotBounds.left - overlayBounds.left,
    top: plotBounds.top - overlayBounds.top,
    width: plotBounds.width,
    height: plotBounds.height,
  };
}

function inPlot(position: CursorPosition, rect: PlotRect): boolean {
  return position.left >= rect.left &&
    position.left <= rect.left + rect.width &&
    position.top >= rect.top &&
    position.top <= rect.top + rect.height;
}

export function WaveformCursorOverlay({
  scope,
  controller,
  cursorState,
  dispatchCursor,
}: WaveformCursorOverlayProps) {
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<DraggedCursor | null>(null);
  const [plotRect, setPlotRect] = useState<PlotRect | null>(null);
  const [hover, setHover] = useState<CursorCandidate | null>(null);
  const deepCapture = useScopeStore((state) => state.deepCapture);
  const isDeep = deepCapture.kind === DeepCaptureKind.Ready &&
    controller.getDisplayMode() === WaveformDisplayMode.Deep;
  const xMin = isDeep && deepCapture.kind === DeepCaptureKind.Ready
    ? deepCapture.position - 5 * deepCapture.scale
    : scope.horizontal.position - 5 * scope.horizontal.scale;
  const xMax = isDeep && deepCapture.kind === DeepCaptureKind.Ready
    ? deepCapture.position + 5 * deepCapture.scale
    : scope.horizontal.position + 5 * scope.horizontal.scale;

  useEffect(() => {
    const overlay = overlayRef.current;
    if (overlay === null) return;
    const update = () => setPlotRect(readPlotRect(overlay));
    update();
    const frame = window.requestAnimationFrame(update);
    const observer = new ResizeObserver(update);
    if (overlay.parentElement !== null) observer.observe(overlay.parentElement);
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [scope, deepCapture]);

  useEffect(() => {
    if (!cursorState.armed) {
      setHover(null);
      dragRef.current = null;
    }
  }, [cursorState.armed]);

  const positionForMarker = (marker: WaveformCursorMarker): CursorPosition | null => {
    if (plotRect === null || !(xMax > xMin)) return null;
    const domain = sourceDomain(scope, marker.source);
    if (domain === null || !(domain.max > domain.min)) return null;
    const position = {
      left: plotRect.left + ((marker.x - xMin) / (xMax - xMin)) * plotRect.width,
      top: plotRect.top + ((domain.max - marker.y) / (domain.max - domain.min)) * plotRect.height,
    };
    return inPlot(position, plotRect) ? position : null;
  };

  const candidateForPointer = (clientX: number, clientY: number): CursorCandidate | null => {
    const overlay = overlayRef.current;
    if (overlay === null || plotRect === null || !(xMax > xMin)) return null;
    const bounds = overlay.getBoundingClientRect();
    const pointer = { left: clientX - bounds.left, top: clientY - bounds.top };
    if (!inPlot(pointer, plotRect)) return null;
    const targetX = xMin + ((pointer.left - plotRect.left) / plotRect.width) * (xMax - xMin);

    let selected: CursorCandidate | null = null;
    let selectedDistance = Number.POSITIVE_INFINITY;
    for (const source of ALL_SOURCES) {
      const frame = controller.getFrame(source);
      const domain = sourceDomain(scope, source);
      if (frame === undefined || domain === null || !(domain.max > domain.min)) continue;
      const point = nearestWaveformPoint(frame, targetX);
      if (point === null) continue;
      const position = {
        left: plotRect.left + ((point.x - xMin) / (xMax - xMin)) * plotRect.width,
        top: plotRect.top + ((domain.max - point.y) / (domain.max - domain.min)) * plotRect.height,
      };
      if (!inPlot(position, plotRect)) continue;
      const distance = Math.hypot(position.left - pointer.left, position.top - pointer.top);
      if (distance < selectedDistance) {
        selectedDistance = distance;
        selected = {
          ...position,
          marker: {
            source,
            unit: waveformSourceUnit(scope, source),
            x: point.x,
            y: point.y,
          },
        };
      }
    }
    return selectedDistance <= SNAP_RADIUS_PX ? selected : null;
  };

  const handleCaptureMove = (event: PointerEvent<HTMLDivElement>) => {
    setHover(candidateForPointer(event.clientX, event.clientY));
  };

  const handleCaptureDown = (event: PointerEvent<HTMLDivElement>) => {
    const candidate = candidateForPointer(event.clientX, event.clientY);
    if (candidate === null) return;
    event.preventDefault();
    dispatchCursor({ type: "place", marker: candidate.marker });
    setHover(candidate);
  };

  const beginMarkerDrag = (
    event: PointerEvent<HTMLButtonElement>,
    slot: WaveformCursorSlot,
  ) => {
    if (!cursorState.armed) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { slot, pointerId: event.pointerId };
    setHover(null);
  };

  const moveMarker = (event: PointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (drag === null || drag.pointerId !== event.pointerId) return;
    const candidate = candidateForPointer(event.clientX, event.clientY);
    if (candidate === null) return;
    dispatchCursor({ type: "move", slot: drag.slot, marker: candidate.marker });
  };

  const finishMarkerDrag = (event: PointerEvent<HTMLButtonElement>) => {
    if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null;
  };

  const markers: Array<[WaveformCursorSlot, WaveformCursorMarker | null]> = [
    ["A", cursorState.markerA],
    ["B", cursorState.markerB],
  ];
  const markerCount = Number(cursorState.markerA !== null) + Number(cursorState.markerB !== null);

  return (
    <div className="waveform-cursor-overlay" ref={overlayRef}>
      {plotRect !== null && cursorState.armed ? (
        <div
          className="waveform-cursor-capture"
          style={{
            left: plotRect.left,
            top: plotRect.top,
            width: plotRect.width,
            height: plotRect.height,
          }}
          onPointerMove={handleCaptureMove}
          onPointerDown={handleCaptureDown}
          onPointerLeave={() => setHover(null)}
          title={`Cursor mode: place ${cursorState.nextSlot}; drag A/B handles to move them`}
        />
      ) : null}

      {hover !== null && plotRect !== null ? (
        <CursorCrosshair
          className="is-preview"
          position={hover}
          plotRect={plotRect}
          accent={waveformSourceAccent(hover.marker.source)}
        />
      ) : null}

      {plotRect === null ? null : markers.map(([slot, marker]) => {
        if (marker === null) return null;
        const position = positionForMarker(marker);
        if (position === null) return null;
        return (
          <CursorCrosshair
            className={`is-marker cursor-${slot.toLowerCase()}`}
            position={position}
            plotRect={plotRect}
            accent={waveformSourceAccent(marker.source)}
            key={slot}
          >
            <button
              type="button"
              className={`waveform-cursor-handle cursor-${slot.toLowerCase()}`}
              style={{ left: position.left, top: position.top }}
              disabled={!cursorState.armed}
              onPointerDown={(event) => beginMarkerDrag(event, slot)}
              onPointerMove={moveMarker}
              onPointerUp={finishMarkerDrag}
              onPointerCancel={finishMarkerDrag}
              title={cursorState.armed ? `Drag cursor ${slot}` : `Cursor ${slot}`}
            >
              {slot}
            </button>
          </CursorCrosshair>
        );
      })}

      {cursorState.armed || markerCount > 0 ? (
        <CursorReadout scope={scope} state={cursorState} hover={hover?.marker ?? null} />
      ) : null}
    </div>
  );
}

function CursorCrosshair({
  className,
  position,
  plotRect,
  accent,
  children,
}: {
  className: string;
  position: CursorPosition;
  plotRect: PlotRect;
  accent: string;
  children?: React.ReactNode;
}) {
  const style = { "--cursor-accent": accent } as CSSProperties;
  return (
    <div className={`waveform-cursor-crosshair ${className}`} style={style} aria-hidden={children === undefined}>
      <div
        className="waveform-cursor-line is-vertical"
        style={{ left: position.left, top: plotRect.top, height: plotRect.height }}
      />
      <div
        className="waveform-cursor-line is-horizontal"
        style={{ left: plotRect.left, top: position.top, width: plotRect.width }}
      />
      {children}
    </div>
  );
}

function CursorReadout({
  scope,
  state,
  hover,
}: {
  scope: ScopeState;
  state: WaveformCursorState;
  hover: WaveformCursorMarker | null;
}) {
  const a = state.markerA;
  const b = state.markerB;
  const deltaTime = a !== null && b !== null ? b.x - a.x : null;
  const deltaAmplitude = a !== null && b !== null && a.unit === b.unit ? b.y - a.y : null;
  return (
    <div className="waveform-cursor-readout">
      <div className="waveform-cursor-readout-heading">
        <strong>Cursors</strong>
        {state.armed ? <span>next {state.nextSlot}</span> : <span>locked</span>}
      </div>
      {a !== null ? <CursorReadoutRow slot="A" marker={a} /> : null}
      {b !== null ? <CursorReadoutRow slot="B" marker={b} /> : null}
      {deltaTime !== null ? (
        <div className="waveform-cursor-delta">
          <span>Δt {formatStableSeconds(deltaTime)}</span>
          {deltaTime !== 0 ? <span>1/Δt {formatStableHertz(1 / Math.abs(deltaTime))}</span> : null}
          {deltaAmplitude !== null && a !== null ? (
            <span>Δy {formatStableAmplitude(deltaAmplitude, a.unit)}</span>
          ) : null}
        </div>
      ) : null}
      {state.armed && hover !== null ? (
        <div className="waveform-cursor-hover">
          {waveformSourceLabel(hover.source)} {formatStableSeconds(hover.x)} {formatStableAmplitude(hover.y, hover.unit)}
        </div>
      ) : null}
      {state.armed && a === null && b === null && hover === null ? (
        <div className="muted">Move near a trace and click to place A.</div>
      ) : null}
    </div>
  );
}

function CursorReadoutRow({
  slot,
  marker,
}: {
  slot: WaveformCursorSlot;
  marker: WaveformCursorMarker;
}) {
  const style = { "--channel-accent": waveformSourceAccent(marker.source) } as CSSProperties;
  return (
    <div className="waveform-cursor-readout-row" style={style}>
      <strong>{slot}</strong>
      <span className="waveform-cursor-source">{waveformSourceLabel(marker.source)}</span>
      <span>{formatStableSeconds(marker.x)}</span>
      <span>{formatStableAmplitude(marker.y, marker.unit)}</span>
    </div>
  );
}
