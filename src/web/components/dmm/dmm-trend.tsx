import { useEffect, useRef } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";

import {
  DmmReadingKind,
  dmmUnitForFunction,
  type DmmMeasurementFunction,
  type DmmReadingSnapshot,
} from "../../../shared/dmm-types.js";
import { formatDmmValue } from "../../dmm/dmm-format.js";
import {
  DMM_TREND_HORIZONTAL_DIVISIONS,
  DMM_TREND_RETENTION_SECONDS,
  normalizeDmmTrendHorizontal,
  type DmmTrendHorizontal,
} from "./dmm-horizontal-controls.js";
import {
  divisionSplits,
  formatTimeAxisValues,
  timeAxisUnit,
} from "../../waveform/waveform-axis.js";

interface DmmTrendProps {
  measurementFunction: DmmMeasurementFunction;
  snapshot: DmmReadingSnapshot | null;
  horizontal: DmmTrendHorizontal;
}

const AXIS_FONT = "11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
const TREND_STROKE = "#7ab8e8";
const ELAPSED_TIME_UNIT = timeAxisUnit(1);

type TrendValue = number | null;
export type TrendData = [number[], TrendValue[]];
export interface TrendVisibleRange {
  readonly min: number;
  readonly max: number;
}

export function appendDmmTrendSnapshot(
  data: TrendData,
  elapsedSeconds: number,
  snapshot: DmmReadingSnapshot,
): void {
  if (!Number.isFinite(elapsedSeconds) || elapsedSeconds < 0) {
    throw new Error("DMM trend elapsed time must be a non-negative finite number");
  }

  data[0].push(elapsedSeconds);
  data[1].push(snapshot.kind === DmmReadingKind.Value ? snapshot.value : null);

  const cutoff = elapsedSeconds - DMM_TREND_RETENTION_SECONDS;
  let removeCount = 0;
  while (removeCount < data[0].length && data[0][removeCount]! < cutoff) {
    removeCount += 1;
  }
  if (removeCount > 0) {
    data[0].splice(0, removeCount);
    data[1].splice(0, removeCount);
  }
}

export function dmmTrendVisibleRange(
  latestSeconds: number,
  horizontal: DmmTrendHorizontal,
): TrendVisibleRange {
  if (!Number.isFinite(latestSeconds) || latestSeconds < 0) {
    throw new Error("DMM trend latest time must be a non-negative finite number");
  }

  const normalized = normalizeDmmTrendHorizontal(horizontal);
  const width = normalized.scale * DMM_TREND_HORIZONTAL_DIVISIONS;
  const rightEdge = latestSeconds + normalized.position;
  return { min: rightEdge - width, max: rightEdge };
}

export function renderableDmmTrendData(
  data: TrendData,
  visibleRange: TrendVisibleRange,
): TrendData {
  if (data[0].length !== data[1].length) {
    throw new Error("DMM trend X/Y data lengths must match");
  }
  if (data[0].length >= 2) {
    return data;
  }
  if (data[0].length === 0) {
    return [[visibleRange.min, visibleRange.max], [null, null]];
  }

  const elapsedSeconds = data[0][0]!;
  const value = data[1][0] ?? null;
  const padding = Math.max(
    Math.abs(visibleRange.max - visibleRange.min) / 1000,
    Number.EPSILON,
  );
  return [[elapsedSeconds - padding, elapsedSeconds], [null, value]];
}

export function dmmTrendYRange(
  _plot: uPlot,
  initialMin: number,
  initialMax: number,
): [number, number] {
  if (!Number.isFinite(initialMin) || !Number.isFinite(initialMax)) {
    return [-1, 1];
  }
  if (initialMin === initialMax) {
    const padding = Math.max(Math.abs(initialMin) * 0.05, 1e-12);
    return [initialMin - padding, initialMax + padding];
  }

  const padding = (initialMax - initialMin) * 0.08;
  return [initialMin - padding, initialMax + padding];
}

export function DmmTrend({
  measurementFunction,
  snapshot,
  horizontal,
}: DmmTrendProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const plotRef = useRef<uPlot | null>(null);
  const dataRef = useRef<TrendData>([[], []]);
  const startedAtRef = useRef<number | null>(null);
  const latestElapsedRef = useRef(0);
  const horizontalRef = useRef(normalizeDmmTrendHorizontal(horizontal));
  const unit = dmmUnitForFunction(measurementFunction);

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) {
      return;
    }

    dataRef.current = [[], []];
    startedAtRef.current = null;
    latestElapsedRef.current = 0;

    const initialRange = dmmTrendVisibleRange(0, horizontalRef.current);
    const width = Math.max(1, host.clientWidth);
    const height = Math.max(1, host.clientHeight);
    const options = {
      width,
      height,
      cursor: { show: false },
      legend: { show: false },
      scales: {
        x: { auto: false, time: false },
        y: { auto: true, range: dmmTrendYRange },
      },
      axes: [
        {
          stroke: "#9aa6b2",
          font: AXIS_FONT,
          size: 28,
          space: 42,
          splits: (_plot: uPlot, _axisIndex: number, scaleMin: number, scaleMax: number) =>
            divisionSplits(scaleMin, scaleMax, DMM_TREND_HORIZONTAL_DIVISIONS),
          values: (_plot: uPlot, ticks: number[]) =>
            formatTimeAxisValues(ticks, ELAPSED_TIME_UNIT),
          grid: { stroke: "#202832", width: 1 },
          ticks: { stroke: "#47515c", width: 1 },
        },
        {
          stroke: "#9aa6b2",
          font: AXIS_FONT,
          size: 72,
          values: (_plot: uPlot, ticks: number[]) => ticks.map(formatTrendAxisValue),
          grid: { stroke: "#202832", width: 1 },
          ticks: { stroke: "#47515c", width: 1 },
        },
      ],
      series: [
        {},
        {
          label: "Reading",
          stroke: TREND_STROKE,
          width: 1.5,
          points: { show: false },
          spanGaps: false,
        },
      ],
    } as unknown as uPlot.Options;

    const plot = new uPlot(
      options,
      renderableDmmTrendData(dataRef.current, initialRange) as unknown as uPlot.AlignedData,
      host,
    );
    plot.setScale("x", initialRange);
    plotRef.current = plot;

    const resizeObserver = new ResizeObserver(() => {
      plot.setSize({
        width: Math.max(1, host.clientWidth),
        height: Math.max(1, host.clientHeight),
      });
    });
    resizeObserver.observe(host);

    return () => {
      resizeObserver.disconnect();
      plot.destroy();
      plotRef.current = null;
    };
  }, [measurementFunction, unit]);

  useEffect(() => {
    horizontalRef.current = normalizeDmmTrendHorizontal(horizontal);
    const plot = plotRef.current;
    if (plot === null) {
      return;
    }

    const visibleRange = dmmTrendVisibleRange(
      latestElapsedRef.current,
      horizontalRef.current,
    );
    plot.setScale("x", visibleRange);
    plot.redraw();
  }, [horizontal]);

  useEffect(() => {
    if (snapshot === null || snapshot.function !== measurementFunction) {
      return;
    }
    const plot = plotRef.current;
    if (plot === null) {
      return;
    }

    const nowSeconds = performance.now() / 1000;
    const startedAt = startedAtRef.current ?? nowSeconds;
    startedAtRef.current = startedAt;
    const elapsedSeconds = nowSeconds - startedAt;
    latestElapsedRef.current = elapsedSeconds;

    appendDmmTrendSnapshot(dataRef.current, elapsedSeconds, snapshot);
    const visibleRange = dmmTrendVisibleRange(elapsedSeconds, horizontalRef.current);
    plot.setData(
      renderableDmmTrendData(dataRef.current, visibleRange) as unknown as uPlot.AlignedData,
    );
    plot.setScale("x", visibleRange);
    plot.redraw();
  }, [measurementFunction, snapshot]);

  function formatTrendAxisValue(value: number): string {
    const formatted = formatDmmValue(value, unit);
    return `${formatted.value} ${formatted.unit}`.trim();
  }

  return (
    <section className="panel dmm-trend-panel">
      <div className="dmm-section-heading">
        <div>
          <span className="dmm-eyebrow">Browser history</span>
          <h2>Snapshot trend</h2>
        </div>
      </div>
      <div className="dmm-trend-plot" ref={hostRef} />
      <p className="muted dmm-trend-note">
        Browser-received latest-reading snapshots; this is a visual trend, not one point per physical conversion.
      </p>
    </section>
  );
}
