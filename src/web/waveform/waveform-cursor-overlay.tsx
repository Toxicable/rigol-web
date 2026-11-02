import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type Dispatch,
  type PointerEvent,
  type ReactNode,
} from "react";

import {
  MathOperator,
  WaveformSource,
  channelForWaveformSource,
  mathForWaveformSource,
  waveformSourceUnit,
  waveformSourceUnitLabel,
  type ScopeState,
} from "../../shared/scope-types.js";
import {
  channelUnitSymbol,
  formatStableAmplitudeWithUnit,
  formatStableHertz,
  formatStableSeconds,
} from "../format-value.js";
import { DeepCaptureKind, useScopeStore } from "../scope-store.js";
import { useWaveformFocusStore } from "../waveform-focus-store.js";
import { waveformSourceAccent, waveformSourceLabel } from "../waveform-source-style.js";
import { WaveformDisplayMode, type WaveformController } from "./waveform-controller.js";
import {
  nearestWaveformSeriesPoint,
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
  source: WaveformSource;
}

const SNAP_RADIUS_PX = 96;

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
  if (state === undefined) return null;
  if (state.scale === null || state.offset === null || !(state.scale > 0)) {
    return { min: -0.5, max: 1.5 };
  }
  return {
    min: -state.offset - 4 * state.scale,
    max: -state.offset + 4 * state.scale,
  };
}

function isFrequencyDomainSource(scope: ScopeState, source: WaveformSource): boolean {
  const math = mathForWaveformSource(source);
  return math !== null && scope.math[math - 1]?.operator === MathOperator.Fft;
}

function sourceXRange(
  scope: ScopeState,
  source: WaveformSource,
  timeRange: { min: number; max: number },
): { min: number; max: number } {
  const math = mathForWaveformSource(source);
  if (math !== null && isFrequencyDomainSource(scope, source)) {
    const range = scope.math[math - 1]?.frequencyRangeHz;
    if (range !== null && range !== undefined && range.end > range.start) {
      return { min: range.start, max: range.end };
    }
  }
  return timeRange;
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
  const focusedSource = useWaveformFocusStore((state) => state.focusedSource);
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
    if (plotRect === null) return null;
    const xRange = sourceXRange(scope, marker.source, { min: xMin, max: xMax });
    if (!(xRange.max > xRange.min)) return null;
    const domain = sourceDomain(scope, marker.source);
    if (domain === null || !(domain.max > domain.min)) return null;
    const position = {
      left: plotRect.left + ((marker.x - xRange.min) / (xRange.max - xRange.min)) * plotRect.width,
      top: plotRect.top + ((domain.max - marker.y) / (domain.max - domain.min)) * plotRect.height,
    };
    return inPlot(position, plotRect) ? position : null;
  };

  const candidateForPointer = (
    clientX: number,
    clientY: number,
    sourceOverride?: WaveformSource,
  ): CursorCandidate | null => {
    const overlay = overlayRef.current;
    const source = sourceOverride ?? focusedSource;
    if (overlay === null || plotRect === null || source === null) return null;
    const xRange = sourceXRange(scope, source, { min: xMin, max: xMax });
    if (!(xRange.max > xRange.min)) return null;
    const bounds = overlay.getBoundingClientRect();
    const pointer = { left: clientX - bounds.left, top: clientY - bounds.top };
    if (!inPlot(pointer, plotRect)) return null;
    const frame = controller.getFrame(source);
    const domain = sourceDomain(scope, source);
    const [xValues, yValues] = controller.getPlotData()[source] ?? [new Float64Array(0), new Float32Array(0)];
    if (frame === undefined || domain === null || !(domain.max > domain.min)) return null;
    const targetX = xRange.min + ((pointer.left - plotRect.left) / plotRect.width) * (xRange.max - xRange.min);
    const targetY = domain.max - ((pointer.top - plotRect.top) / plotRect.height) * (domain.max - domain.min);
    const point = nearestWaveformSeriesPoint(
      xValues,
      yValues,
      targetX,
      targetY,
      plotRect.width / (xRange.max - xRange.min),
      plotRect.height / (domain.max - domain.min),
    );
    if (point === null) return null;
    const position = {
      left: plotRect.left + ((point.x - xRange.min) / (xRange.max - xRange.min)) * plotRect.width,
      top: plotRect.top + ((domain.max - point.y) / (domain.max - domain.min)) * plotRect.height,
    };
    if (!inPlot(position, plotRect) || point.distance > SNAP_RADIUS_PX) return null;
    return {
      ...position,
      marker: {
        source,
        unit: waveformSourceUnit(scope, source),
        unitLabel: waveformSourceUnitLabel(scope, source),
        xUnit: isFrequencyDomainSource(scope, source) ? "Hz" : "s",
        x: point.x,
        y: point.y,
      },
    };
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
    const marker = slot === "A" ? cursorState.markerA : cursorState.markerB;
    const source = marker?.source ?? focusedSource;
    if (source === null) return;
    dragRef.current = { slot, pointerId: event.pointerId, source };
    setHover(null);
  };

  const moveMarker = (event: PointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (drag === null || drag.pointerId !== event.pointerId) return;
    const candidate = candidateForPointer(event.clientX, event.clientY, drag.source);
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
        <CursorReadout state={cursorState} hover={hover?.marker ?? null} />
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
  children?: ReactNode;
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
  state,
  hover,
}: {
  state: WaveformCursorState;
  hover: WaveformCursorMarker | null;
}) {
  const a = state.markerA;
  const b = state.markerB;
  const deltaX = a !== null && b !== null && a.xUnit === b.xUnit ? b.x - a.x : null;
  const xUnit = a?.xUnit ?? b?.xUnit ?? "s";
  const unitA = a === null ? null : a.unitLabel ?? channelUnitSymbol(a.unit);
  const unitB = b === null ? null : b.unitLabel ?? channelUnitSymbol(b.unit);
  const deltaAmplitude = a !== null && b !== null && unitA === unitB ? b.y - a.y : null;
  return (
    <div className="waveform-cursor-readout">
      <div className="waveform-cursor-readout-heading">
        <strong>Cursors</strong>
        {state.armed ? <span>next {state.nextSlot}</span> : <span>locked</span>}
      </div>
      {a !== null ? <CursorReadoutRow slot="A" marker={a} /> : null}
      {b !== null ? <CursorReadoutRow slot="B" marker={b} /> : null}
      {deltaX !== null ? (
        <div className="waveform-cursor-delta">
          <span>{xUnit === "Hz" ? "Δf" : "Δt"} {xUnit === "Hz" ? formatStableHertz(deltaX) : formatStableSeconds(deltaX)}</span>
          {deltaX !== 0 ? (
            <span>
              {xUnit === "Hz" ? "1/Δf" : "1/Δt"} {xUnit === "Hz" ? formatStableSeconds(1 / Math.abs(deltaX)) : formatStableHertz(1 / Math.abs(deltaX))}
            </span>
          ) : null}
          {deltaAmplitude !== null && a !== null ? (
            <span>Δy {formatStableAmplitudeWithUnit(deltaAmplitude, unitA ?? "unit")}</span>
          ) : null}
        </div>
      ) : null}
      {state.armed && hover !== null ? (
        <div className="waveform-cursor-hover">
          {waveformSourceLabel(hover.source)} {hover.xUnit === "Hz" ? formatStableHertz(hover.x) : formatStableSeconds(hover.x)} {formatStableAmplitudeWithUnit(hover.y, hover.unitLabel ?? channelUnitSymbol(hover.unit))}
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
      <span>{marker.xUnit === "Hz" ? formatStableHertz(marker.x) : formatStableSeconds(marker.x)}</span>
      <span>{formatStableAmplitudeWithUnit(marker.y, marker.unitLabel ?? channelUnitSymbol(marker.unit))}</span>
    </div>
  );
}
