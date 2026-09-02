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
  divisionSplits,
  formatTimeAxisValues,
  timeAxisUnit,
} from "../../waveform/waveform-axis.js";

interface DmmTrendProps {
  measurementFunction: DmmMeasurementFunction;
  snapshot: DmmReadingSnapshot | null;
}

export const DMM_TREND_WINDOW_SECONDS = 5 * 60;
const DMM_TREND_MINIMUM_X_SECONDS = 10;
const AXIS_FONT = "11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
const TREND_STROKE = "#7ab8e8";
const ELAPSED_TIME_UNIT = timeAxisUnit(1);

type TrendValue = number | null;
type TrendData = [number[], TrendValue[]];

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

  const cutoff = elapsedSeconds - DMM_TREND_WINDOW_SECONDS;
  let removeCount = 0;
  while (removeCount < data[0].length && data[0][removeCount]! < cutoff) {
    removeCount += 1;
  }
  if (removeCount > 0) {
    data[0].splice(0, removeCount);
    data[1].splice(0, removeCount);
  }
}

export function DmmTrend({ measurementFunction, snapshot }: DmmTrendProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const plotRef = useRef<uPlot | null>(null);
  const dataRef = useRef<TrendData>([[], []]);
  const startedAtRef = useRef<number | null>(null);
  const unit = dmmUnitForFunction(measurementFunction);

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) {
      return;
    }

    dataRef.current = [[], []];
    startedAtRef.current = null;

    const width = Math.max(1, host.clientWidth);
    const height = Math.max(1, host.clientHeight);
    const options = {
      width,
      height,
      cursor: { show: false },
      legend: { show: false },
      scales: {
        x: { auto: false, time: false },
        y: { auto: true },
      },
      axes: [
        {
          stroke: "#9aa6b2",
          font: AXIS_FONT,
          size: 28,
          space: 42,
          splits: (_plot: uPlot, _axisIndex: number, scaleMin: number, scaleMax: number) =>
            divisionSplits(scaleMin, scaleMax, 10),
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
      dataRef.current as unknown as uPlot.AlignedData,
      host,
    );
    plot.setScale("x", { min: 0, max: DMM_TREND_MINIMUM_X_SECONDS });
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

    appendDmmTrendSnapshot(dataRef.current, elapsedSeconds, snapshot);
    plot.setData(dataRef.current as unknown as uPlot.AlignedData, false);
    plot.setScale("x", {
      min: Math.max(0, elapsedSeconds - DMM_TREND_WINDOW_SECONDS),
      max: Math.max(DMM_TREND_MINIMUM_X_SECONDS, elapsedSeconds),
    });
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
        <span className="status-pill">5 min</span>
      </div>
      <div className="dmm-trend-plot" ref={hostRef} />
      <p className="muted dmm-trend-note">
        Browser-received latest-reading snapshots; this is a visual trend, not one point per physical conversion.
      </p>
    </section>
  );
}
