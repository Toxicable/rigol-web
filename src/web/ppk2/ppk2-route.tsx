import { useEffect, useMemo } from "react";

import { AcquisitionOperationState } from "../../shared/acquisition-types.js";
import type { Ppk2DisplayBucket } from "../../shared/ppk2-types.js";
import { AppTransportKind, type AppTransportState, useAppTransportStore } from "../app-transport-store.js";
import { InstrumentHeader } from "../components/instrument-header.js";
import "./ppk2.css";
import type { Ppk2Actions } from "./ppk2-actions.js";
import type { Ppk2Binding } from "./ppk2-binding.js";
import { bindPpk2Route } from "./ppk2-route-binding.js";
import {
  Ppk2BrowserConnectionKind,
  type Ppk2BrowserConnection,
  usePpk2Store,
} from "./ppk2-store.js";

interface Ppk2RouteProps {
  binding: Ppk2Binding;
  actions: Ppk2Actions;
}

export function Ppk2Route({ binding, actions }: Ppk2RouteProps) {
  const transport = useAppTransportStore((state) => state.transport);
  const connection = usePpk2Store((state) => state.connection);
  const stats = usePpk2Store((state) => state.stats);
  const liveBuckets = usePpk2Store((state) => state.liveBuckets);
  const viewport = usePpk2Store((state) => state.viewport);
  const pendingRequest = usePpk2Store((state) => state.pendingRequest);
  const requestError = usePpk2Store((state) => state.requestError);

  useEffect(() => bindPpk2Route(binding), [binding]);

  const buckets = viewport?.buckets ?? liveBuckets;
  const running = stats.operation?.state === AcquisitionOperationState.Running;
  const connected =
    transport.kind === AppTransportKind.Connected &&
    connection.kind === Ppk2BrowserConnectionKind.Connected;

  return (
    <section className="ppk2-route">
      <InstrumentHeader>
        <div className="scope-toolbar-content">
          <span className="status-pill" aria-live="polite">
            {connectionLabel(transport, connection)}
          </span>
          {connection.kind === Ppk2BrowserConnectionKind.Connected ? (
            <span className="ppk2-identity">
              PPK2 · session {connection.info.sourceSessionId}
              {connection.info.hardwareRevision === null
                ? ""
                : ` · HW ${connection.info.hardwareRevision}`}
            </span>
          ) : null}
          <div className="toolbar-actions">
            <button
              type="button"
              disabled={!connected || running || pendingRequest !== null}
              onClick={() => void actions.startCapture()}
            >
              Start Capture
            </button>
            <button
              type="button"
              disabled={!connected || !running || pendingRequest !== null}
              onClick={() => void actions.stopCapture()}
            >
              Stop Capture
            </button>
            <button
              type="button"
              disabled={
                running ||
                stats.operation === null ||
                stats.latestSequence === null ||
                pendingRequest !== null
              }
              onClick={() => void actions.loadRetainedHistory()}
            >
              Load retained history
            </button>
          </div>
        </div>
      </InstrumentHeader>

      <div className="ppk2-layout">
        <section className="panel ppk2-trace-panel">
          <div className="ppk2-trace-heading">
            <div>
              <h1>PPK2 Current</h1>
              <p>
                {viewport === null
                  ? "Live decimated view"
                  : `Retained acquisition ${viewport.operationId}`}
              </p>
            </div>
            <strong>{formatCurrentUa(stats.latestCurrentUa)}</strong>
          </div>
          <Ppk2Trace buckets={buckets} />
          {buckets.length === 0 ? (
            <div className="ppk2-empty-trace">
              {running ? "Waiting for samples." : "Start a capture to collect current data."}
            </div>
          ) : null}
        </section>

        <aside className="ppk2-side-column">
          <section className="panel">
            <h2>Capture</h2>
            <dl className="ppk2-stats-grid">
              <Stat label="State" value={operationLabel(stats.operation?.state ?? null)} />
              <Stat label="Samples" value={stats.receivedSamples.toLocaleString()} />
              <Stat label="Lost" value={stats.lostSamples.toLocaleString()} danger={stats.lostSamples > 0} />
              <Stat label="Retained" value={formatSeconds(stats.retainedSeconds)} />
              <Stat label="Latest" value={formatCurrentUa(stats.latestCurrentUa)} />
              <Stat label="Mean" value={formatCurrentUa(stats.meanCurrentUa)} />
              <Stat label="RMS" value={formatCurrentUa(stats.rmsCurrentUa)} />
              <Stat label="Min" value={formatCurrentUa(stats.minCurrentUa)} />
              <Stat label="Max" value={formatCurrentUa(stats.maxCurrentUa)} />
              <Stat label="Charge" value={formatCharge(stats.chargeMicroampHours)} />
            </dl>
          </section>

          <section className="panel">
            <h2>Source</h2>
            <dl className="ppk2-source-grid">
              <Stat
                label="Bridge"
                value={connection.kind === Ppk2BrowserConnectionKind.Connected
                  ? `session ${connection.info.sourceSessionId}`
                  : "offline"}
              />
              <Stat
                label="VDD metadata"
                value={connection.kind === Ppk2BrowserConnectionKind.Connected
                  ? `${connection.info.vddMv} mV`
                  : "—"}
              />
              <Stat label="Sample rate" value="100 kSa/s" />
              <Stat label="Mode" value="Ampere meter" />
            </dl>
          </section>

          {requestError !== null ? (
            <div className="ppk2-request-error" role="alert">
              PPK2 request failed: {requestError}
            </div>
          ) : null}
        </aside>
      </div>
    </section>
  );
}

interface StatProps {
  label: string;
  value: string;
  danger?: boolean;
}

function Stat({ label, value, danger = false }: StatProps) {
  return (
    <div>
      <dt>{label}</dt>
      <dd className={danger ? "ppk2-danger" : undefined}>{value}</dd>
    </div>
  );
}

function Ppk2Trace({ buckets }: { buckets: readonly Ppk2DisplayBucket[] }) {
  const geometry = useMemo(() => traceGeometry(buckets), [buckets]);
  if (geometry === null) return null;

  return (
    <svg
      className="ppk2-trace"
      viewBox="0 0 1000 360"
      preserveAspectRatio="none"
      role="img"
      aria-label="Decimated PPK2 current trace"
    >
      <g className="ppk2-trace-grid">
        {[0, 1, 2, 3, 4, 5].map((index) => (
          <line key={`h-${index}`} x1="0" x2="1000" y1={index * 72} y2={index * 72} />
        ))}
        {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((index) => (
          <line key={`v-${index}`} x1={index * 100} x2={index * 100} y1="0" y2="360" />
        ))}
      </g>
      <path className="ppk2-trace-envelope" d={geometry.envelopePath} />
      <polyline className="ppk2-trace-mean" points={geometry.meanPoints} />
    </svg>
  );
}

function traceGeometry(buckets: readonly Ppk2DisplayBucket[]): {
  meanPoints: string;
  envelopePath: string;
} | null {
  if (buckets.length === 0) return null;
  let minimum = Number.POSITIVE_INFINITY;
  let maximum = Number.NEGATIVE_INFINITY;
  for (const bucket of buckets) {
    minimum = Math.min(minimum, bucket.minCurrentUa);
    maximum = Math.max(maximum, bucket.maxCurrentUa);
  }
  if (!Number.isFinite(minimum) || !Number.isFinite(maximum)) return null;
  const span = Math.max(maximum - minimum, Math.max(Math.abs(maximum), 1) * 0.02);
  const lower = minimum - span * 0.08;
  const upper = maximum + span * 0.08;
  const range = upper - lower;
  const x = (index: number): number => buckets.length === 1
    ? 500
    : index * 1000 / (buckets.length - 1);
  const y = (value: number): number => 360 - ((value - lower) / range) * 360;

  const meanPoints = buckets
    .map((bucket, index) => `${x(index).toFixed(2)},${y(bucket.meanCurrentUa).toFixed(2)}`)
    .join(" ");
  const upperPoints = buckets
    .map((bucket, index) => `${x(index).toFixed(2)},${y(bucket.maxCurrentUa).toFixed(2)}`);
  const lowerPoints = buckets
    .map((bucket, index) => `${x(index).toFixed(2)},${y(bucket.minCurrentUa).toFixed(2)}`)
    .reverse();
  return {
    meanPoints,
    envelopePath: `M ${[...upperPoints, ...lowerPoints].join(" L ")} Z`,
  };
}

function connectionLabel(
  transport: AppTransportState,
  connection: Ppk2BrowserConnection,
): string {
  switch (transport.kind) {
    case AppTransportKind.Connecting:
      return "Connecting";
    case AppTransportKind.Disconnected:
      return "Transport offline";
    case AppTransportKind.Connected:
      break;
  }

  switch (connection.kind) {
    case Ppk2BrowserConnectionKind.AwaitingInstrument:
      return "Starting PPK2";
    case Ppk2BrowserConnectionKind.InstrumentDisconnected:
      return "PPK2 offline";
    case Ppk2BrowserConnectionKind.Connected:
      return "Connected";
  }
}

function operationLabel(state: AcquisitionOperationState | null): string {
  switch (state) {
    case AcquisitionOperationState.Running:
      return "Running";
    case AcquisitionOperationState.Stopped:
      return "Stopped";
    case AcquisitionOperationState.Failed:
      return "Failed";
    case null:
      return "Idle";
  }
}

function formatCurrentUa(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  const absolute = Math.abs(value);
  if (absolute >= 1_000_000) return `${formatNumber(value / 1_000_000)} A`;
  if (absolute >= 1_000) return `${formatNumber(value / 1_000)} mA`;
  if (absolute >= 1) return `${formatNumber(value)} µA`;
  return `${formatNumber(value * 1_000)} nA`;
}

function formatCharge(microampHours: number): string {
  const absolute = Math.abs(microampHours);
  if (absolute >= 1_000_000) return `${formatNumber(microampHours / 1_000_000)} Ah`;
  if (absolute >= 1_000) return `${formatNumber(microampHours / 1_000)} mAh`;
  return `${formatNumber(microampHours)} µAh`;
}

function formatSeconds(seconds: number): string {
  if (!Number.isFinite(seconds)) return "—";
  if (seconds >= 60) return `${formatNumber(seconds / 60)} min`;
  return `${formatNumber(seconds)} s`;
}

function formatNumber(value: number): string {
  const absolute = Math.abs(value);
  const digits = absolute >= 100 ? 3 : absolute >= 10 ? 3 : 4;
  return Number(value.toPrecision(digits)).toString();
}
