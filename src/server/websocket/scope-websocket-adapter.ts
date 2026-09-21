import { SupportedInstrument } from "../../shared/instrument-types.js";
import {
  AcquisitionType,
  Channel,
  ChannelBandwidthLimit,
  ChannelCoupling,
  EdgeSlope,
  MathChannel,
  MathOperator,
  MathSource,
  MeasurementKind,
  TimebaseMode,
  TriggerCoupling,
  TriggerSweep,
  TriggerType,
  WaveformSource,
  waveformSourceForChannel,
  type MeasurementSpec,
} from "../../shared/scope-types.js";
import {
  WAVEFORM_FRAME_VERSION,
  WAVEFORM_HEADER_BYTES,
  WAVEFORM_MAGIC,
} from "../../shared/waveform-protocol.js";
import {
  AcquisitionAction,
  ControlKind,
  MessageType,
  PROTOCOL_VERSION,
  WaveformKind,
  type ControlChange,
  type InteractiveControl,
  type NonEmptyArray,
  type ServerJsonMessage,
  type WaveformViewportRequestMessage,
} from "../../shared/websocket-protocol.js";
import {
  ScopeConnectionKind,
  type ScopeConnection,
} from "../instruments/instrument-connection.js";

import type { ScopeApplicationService } from "../scope/scope-service.js";
import type {
  WebSocketAdapterHost,
  WebSocketInstrumentAdapter,
  WebSocketSession,
} from "./websocket-adapter.js";
import {
  isRecord,
  readFiniteNumber,
  readInstrument,
  readNonNegativeInteger,
  readPositiveInteger,
  readRequestId,
} from "./websocket-validation.js";

interface WaveformHeader {
  kind: WaveformKind;
  source: WaveformSource;
  captureId: number;
}

interface ScopeClientState {
  pendingLiveFrames: Map<WaveformSource, Uint8Array>;
  liveSendInFlight: boolean;
  viewportGenerations: Map<Channel, number>;
}

export class ScopeWebSocketAdapter implements WebSocketInstrumentAdapter {
  public readonly instrument = SupportedInstrument.Dho804;

  private host: WebSocketAdapterHost | null = null;
  private connection: ScopeConnection;
  private connectionRevision = 0;
  private unsubscribeServices: Array<() => void> = [];
  private readonly clients = new WeakMap<WebSocketSession, ScopeClientState>();
  private readonly latestLiveFrames = new Map<WaveformSource, Uint8Array>();
  private interactionOwner: WebSocketSession | null = null;

  public constructor(private readonly scopeService: ScopeApplicationService) {
    this.connection = scopeService.getConnection();
  }

  public attach(host: WebSocketAdapterHost): void {
    if (this.host !== null) throw new Error("Scope WebSocket adapter is already attached");
    this.host = host;
    this.unsubscribeServices = [
      this.scopeService.subscribeConnection((connection) => {
        this.connection = connection;
        this.connectionRevision += 1;
        this.latestLiveFrames.clear();
        if (connection.kind === ScopeConnectionKind.Disconnected) this.releaseInteractionOwner();
        host.broadcastJson(this.instrument, this.lifecycleMessage(connection));
      }),
      this.scopeService.subscribeState((state) => {
        if (this.connection.kind === ScopeConnectionKind.Connected) {
          this.connection = { ...this.connection, state };
        }
        host.broadcastJson(this.instrument, { type: MessageType.ScopeState, state });
      }),
      this.scopeService.subscribeWaveform((frame) => this.broadcastWaveform(frame)),
    ];
  }

  public detach(): void {
    this.releaseInteractionOwner();
    for (const unsubscribe of this.unsubscribeServices) unsubscribe();
    this.unsubscribeServices = [];
    this.host = null;
  }

  public async tryDispatch(
    session: WebSocketSession,
    message: Record<string, unknown>,
  ): Promise<boolean> {
    switch (message.type) {
      case MessageType.ControlSet: {
        const requestId = readRequestId(message.requestId);
        const control = readControl(message.control);
        const host = this.requireHost();
        host.requireSubscribed(session, this.instrument);
        const revision = this.connectedRevision();
        const pausesLive =
          control.kind === ControlKind.HorizontalScale ||
          control.kind === ControlKind.HorizontalPosition ||
          control.kind === ControlKind.HorizontalMode;
        if (pausesLive) await this.scopeService.pauseLiveWaveform();
        console.info("Scope control requested", {
          kind: control.kind,
          value: control.value,
          channel: "channel" in control ? control.channel : undefined,
          math: "math" in control ? control.math : undefined,
          pausesLive,
        });
        try {
          await this.scopeService.setControl(control);
          this.requireConnectionRevision(revision);
          // Complete the UI request immediately. The live reader remains
          // paused until the control write has completed.
          host.sendCompleted(session, requestId);
        } finally {
          if (pausesLive && this.interactionOwner === null) this.scopeService.resumeLiveWaveform();
        }
        return true;
      }

      case MessageType.InteractionUpdate: {
        const control = readInteractiveControl(message.control);
        const host = this.requireHost();
        try {
          host.requireSubscribed(session, this.instrument);
          this.connectedRevision();
          await this.acquireInteraction(session);
          await this.scopeService.updateInteraction(control);
        } catch (error) {
          console.error("Interactive scope update failed", error);
        }
        return true;
      }

      case MessageType.InteractionCommit: {
        const requestId = readRequestId(message.requestId);
        const control = readInteractiveControl(message.control);
        const host = this.requireHost();
        host.requireSubscribed(session, this.instrument);
        const revision = this.connectedRevision();
        await this.acquireInteraction(session);
        try {
          await this.scopeService.commitInteraction(control);
          this.requireConnectionRevision(revision);
          host.sendCompleted(session, requestId);
        } finally {
          this.releaseInteraction(session);
        }
        return true;
      }

      case MessageType.AcquisitionAction: {
        const requestId = readRequestId(message.requestId);
        const action = readAcquisitionAction(message.action);
        const host = this.requireHost();
        host.requireSubscribed(session, this.instrument);
        const revision = this.connectedRevision();
        await this.scopeService.performAcquisitionAction(action);
        this.requireConnectionRevision(revision);
        host.sendCompleted(session, requestId);
        return true;
      }

      case MessageType.ScopeSleep: {
        const requestId = readRequestId(message.requestId);
        const host = this.requireHost();
        host.requireSubscribed(session, this.instrument);
        await this.scopeService.sleep();
        host.sendCompleted(session, requestId);
        return true;
      }

      case MessageType.MeasurementRead: {
        const requestId = readRequestId(message.requestId);
        const measurements = readMeasurements(message.measurements);
        const host = this.requireHost();
        host.requireSubscribed(session, this.instrument);
        const revision = this.connectedRevision();
        const values = await this.scopeService.readMeasurements(measurements);
        this.requireConnectionRevision(revision);
        host.sendJson(session, { type: MessageType.MeasurementResult, requestId, values });
        return true;
      }

      case MessageType.MeasurementSet: {
        const requestId = readRequestId(message.requestId);
        const measurements = readMeasurementList(message.measurements);
        const host = this.requireHost();
        host.requireSubscribed(session, this.instrument);
        const revision = this.connectedRevision();
        await this.scopeService.setMeasurements(measurements);
        this.requireConnectionRevision(revision);
        host.sendCompleted(session, requestId);
        return true;
      }

      case MessageType.ScpiExecute: {
        const instrument = readInstrument(message.instrument);
        if (instrument !== this.instrument) return false;
        if (typeof message.command !== "string") throw new Error("command must be a string");
        const requestId = readRequestId(message.requestId);
        const host = this.requireHost();
        host.requireSubscribed(session, this.instrument);
        const revision = this.connectedRevision();
        const response = await this.scopeService.executeRawScpi(message.command);
        this.requireConnectionRevision(revision);
        host.sendJson(session, { type: MessageType.ScpiResult, requestId, response });
        return true;
      }

      case MessageType.DeepCaptureRequest: {
        const requestId = readRequestId(message.requestId);
        const host = this.requireHost();
        host.requireSubscribed(session, this.instrument);
        const revision = this.connectedRevision();
        const result = await this.scopeService.captureDeep();
        this.requireConnectionRevision(revision);
        host.sendJson(session, {
          type: MessageType.DeepCaptureReady,
          requestId,
          captureId: result.captureId,
          channels: result.channels,
        });
        return true;
      }

      case MessageType.WaveformViewportRequest: {
        const parsed = readViewportRequest(message);
        const host = this.requireHost();
        host.requireSubscribed(session, this.instrument);
        await this.dispatchViewportRequest(session, parsed);
        return true;
      }

      default:
        return false;
    }
  }

  public sendInitialPublications(session: WebSocketSession): void {
    const host = this.requireHost();
    host.sendJson(session, this.lifecycleMessage(this.connection));
    for (const [source, frame] of this.latestLiveFrames) {
      this.queueLiveFrame(session, source, frame);
    }
  }

  public sessionUnsubscribed(session: WebSocketSession): void {
    const state = this.clients.get(session);
    state?.pendingLiveFrames.clear();
    state?.viewportGenerations.clear();
    this.releaseInteraction(session);
  }

  public transportAvailable(session: WebSocketSession): void {
    this.flushPendingLiveFrame(session);
  }

  private lifecycleMessage(connection: ScopeConnection): ServerJsonMessage {
    if (connection.kind === ScopeConnectionKind.Disconnected) {
      return { type: MessageType.ScopeDisconnected, reason: connection.reason };
    }
    return {
      type: MessageType.ScopeConnected,
      protocolVersion: PROTOCOL_VERSION,
      info: connection.info,
      state: connection.state,
    };
  }

  private connectedRevision(): number {
    if (this.connection.kind !== ScopeConnectionKind.Connected) {
      throw new Error(`Scope disconnected: ${this.connection.reason}`);
    }
    return this.connectionRevision;
  }

  private requireConnectionRevision(revision: number): void {
    if (revision !== this.connectionRevision) throw new Error("Scope session changed while request was in flight");
  }

  private requireInteractionAvailable(session: WebSocketSession): void {
    if (this.interactionOwner !== null && this.interactionOwner !== session) {
      throw new Error("Scope interaction is owned by another browser session");
    }
  }

  private async acquireInteraction(session: WebSocketSession): Promise<void> {
    this.requireInteractionAvailable(session);
    if (this.interactionOwner === session) return;
    this.interactionOwner = session;
    try {
      await this.scopeService.pauseLiveWaveform();
    } catch (error) {
      if (this.interactionOwner === session) this.interactionOwner = null;
      throw error;
    }
  }

  private releaseInteraction(session: WebSocketSession): void {
    if (this.interactionOwner !== session) return;
    this.interactionOwner = null;
    this.scopeService.resumeLiveWaveform();
  }

  private releaseInteractionOwner(): void {
    if (this.interactionOwner === null) return;
    this.interactionOwner = null;
    this.scopeService.resumeLiveWaveform();
  }

  private broadcastWaveform(frame: Uint8Array): void {
    const header = readWaveformHeader(frame);
    if (header.kind !== WaveformKind.Live || header.captureId !== 0) {
      throw new Error("Scope waveform publication only accepts live waveform frames");
    }
    this.latestLiveFrames.set(header.source, frame.slice());
    this.requireHost().forEachSubscribed(this.instrument, (session) => {
      this.queueLiveFrame(session, header.source, frame);
    });
  }

  private async dispatchViewportRequest(
    session: WebSocketSession,
    message: WaveformViewportRequestMessage,
  ): Promise<void> {
    const state = this.clientState(session);
    const generation = (state.viewportGenerations.get(message.channel) ?? 0) + 1;
    state.viewportGenerations.set(message.channel, generation);
    const frame = await this.scopeService.requestViewport({
      captureId: message.captureId,
      channel: message.channel,
      startSample: message.startSample,
      endSample: message.endSample,
      pixelWidth: message.pixelWidth,
    });
    const host = this.requireHost();
    if (state.viewportGenerations.get(message.channel) !== generation) {
      host.sendFailure(session, message.requestId, new Error("Viewport request superseded by a newer request"));
      return;
    }
    const header = readWaveformHeader(frame);
    if (
      header.kind !== WaveformKind.DeepViewport ||
      header.captureId !== message.captureId ||
      header.source !== waveformSourceForChannel(message.channel)
    ) {
      throw new Error("Viewport handler returned a mismatched waveform frame");
    }
    if (host.isBackpressured(session)) {
      host.sendFailure(session, message.requestId, new Error("Viewport response dropped because the client is backpressured"));
      return;
    }
    host.sendBinary(session, frame);
  }

  private queueLiveFrame(session: WebSocketSession, source: WaveformSource, frame: Uint8Array): void {
    const host = this.requireHost();
    if (!host.isOpen(session)) return;
    const state = this.clientState(session);
    if (state.liveSendInFlight || host.isBackpressured(session)) {
      state.pendingLiveFrames.set(source, frame);
      return;
    }
    state.pendingLiveFrames.delete(source);
    this.sendLiveFrame(session, frame);
  }

  private sendLiveFrame(session: WebSocketSession, frame: Uint8Array): void {
    const state = this.clientState(session);
    state.liveSendInFlight = true;
    this.requireHost().sendBinary(session, frame, () => {
      state.liveSendInFlight = false;
    });
  }

  private flushPendingLiveFrame(session: WebSocketSession): void {
    const host = this.host;
    const state = this.clients.get(session);
    if (
      host === null || state === undefined || state.liveSendInFlight ||
      !host.isOpen(session) || host.isBackpressured(session)
    ) return;
    const pending = state.pendingLiveFrames.entries().next();
    if (pending.done) return;
    const [source, frame] = pending.value;
    state.pendingLiveFrames.delete(source);
    this.sendLiveFrame(session, frame);
  }

  private clientState(session: WebSocketSession): ScopeClientState {
    const existing = this.clients.get(session);
    if (existing !== undefined) return existing;
    const created: ScopeClientState = {
      pendingLiveFrames: new Map(),
      liveSendInFlight: false,
      viewportGenerations: new Map(),
    };
    this.clients.set(session, created);
    return created;
  }

  private requireHost(): WebSocketAdapterHost {
    if (this.host === null) throw new Error("Scope WebSocket adapter is not attached");
    return this.host;
  }
}

function readChannel(value: unknown): Channel {
  switch (value) {
    case Channel.Ch1:
    case Channel.Ch2:
    case Channel.Ch3:
    case Channel.Ch4:
      return value;
    default:
      throw new Error("channel must be CH1 through CH4");
  }
}

function readWaveformSource(value: unknown): WaveformSource {
  switch (value) {
    case WaveformSource.Ch1:
    case WaveformSource.Ch2:
    case WaveformSource.Ch3:
    case WaveformSource.Ch4:
    case WaveformSource.Math1:
    case WaveformSource.Math2:
    case WaveformSource.Math3:
    case WaveformSource.Math4:
      return value;
    default:
      throw new Error("waveform source must be CH1-CH4 or MATH1-MATH4");
  }
}

function readMathChannel(value: unknown): MathChannel {
  switch (value) {
    case MathChannel.Math1:
    case MathChannel.Math2:
    case MathChannel.Math3:
    case MathChannel.Math4:
      return value;
    default:
      throw new Error("math must be MATH1 through MATH4");
  }
}

function readMathOperator(value: unknown): MathOperator {
  switch (value) {
    case MathOperator.Add:
    case MathOperator.Subtract:
    case MathOperator.Multiply:
    case MathOperator.Divide:
    case MathOperator.And:
    case MathOperator.Or:
    case MathOperator.Xor:
    case MathOperator.Not:
    case MathOperator.Fft:
    case MathOperator.Integrate:
    case MathOperator.Differentiate:
    case MathOperator.SquareRoot:
    case MathOperator.Log10:
    case MathOperator.NaturalLog:
    case MathOperator.Exp:
    case MathOperator.Abs:
    case MathOperator.LowPass:
    case MathOperator.HighPass:
    case MathOperator.BandPass:
    case MathOperator.BandStop:
    case MathOperator.AxB:
      return value;
    default:
      throw new Error("Invalid math operator");
  }
}

function readMathSource(value: unknown): MathSource {
  if (typeof value !== "number") throw new Error("Invalid math source");
  if (
    (value >= MathSource.Ch1 && value <= MathSource.Math4) ||
    (value >= MathSource.Ref1 && value <= MathSource.Ref10)
  ) return value as MathSource;
  throw new Error("Invalid math source");
}

function readChannelCoupling(value: unknown): ChannelCoupling {
  switch (value) {
    case ChannelCoupling.Ac:
    case ChannelCoupling.Dc:
    case ChannelCoupling.Ground:
      return value;
    default:
      throw new Error("Invalid channel coupling");
  }
}

function readChannelBandwidthLimit(value: unknown): ChannelBandwidthLimit {
  switch (value) {
    case ChannelBandwidthLimit.Off:
    case ChannelBandwidthLimit.Mhz20:
      return value;
    default:
      throw new Error("Invalid channel bandwidth limit");
  }
}

function readTimebaseMode(value: unknown): TimebaseMode {
  switch (value) {
    case TimebaseMode.Main:
    case TimebaseMode.Roll:
    case TimebaseMode.Xy:
      return value;
    default:
      throw new Error("Invalid horizontal mode");
  }
}

function readEdgeSlope(value: unknown): EdgeSlope {
  switch (value) {
    case EdgeSlope.Rising:
    case EdgeSlope.Falling:
    case EdgeSlope.Either:
      return value;
    default:
      throw new Error("Invalid Edge slope");
  }
}

function readTriggerSweep(value: unknown): TriggerSweep {
  switch (value) {
    case TriggerSweep.Auto:
    case TriggerSweep.Normal:
    case TriggerSweep.Single:
      return value;
    default:
      throw new Error("Invalid trigger sweep");
  }
}

function readTriggerCoupling(value: unknown): TriggerCoupling {
  switch (value) {
    case TriggerCoupling.Ac:
    case TriggerCoupling.Dc:
    case TriggerCoupling.LowFrequencyReject:
    case TriggerCoupling.HighFrequencyReject:
      return value;
    default:
      throw new Error("Invalid trigger coupling");
  }
}

function readAcquisitionType(value: unknown): AcquisitionType {
  switch (value) {
    case AcquisitionType.Normal:
    case AcquisitionType.Peak:
    case AcquisitionType.Average:
    case AcquisitionType.Ultra:
      return value;
    default:
      throw new Error("Invalid acquisition type");
  }
}

function readMeasurementKind(value: unknown): MeasurementKind {
  switch (value) {
    case MeasurementKind.Vpp:
    case MeasurementKind.Vmax:
    case MeasurementKind.Vmin:
    case MeasurementKind.Vavg:
    case MeasurementKind.Vrms:
    case MeasurementKind.Frequency:
    case MeasurementKind.Period:
    case MeasurementKind.Vtop:
    case MeasurementKind.Vbase:
    case MeasurementKind.Vamp:
    case MeasurementKind.Vupper:
    case MeasurementKind.Vmid:
    case MeasurementKind.Vlower:
    case MeasurementKind.Overshoot:
    case MeasurementKind.Preshoot:
    case MeasurementKind.RiseTime:
    case MeasurementKind.FallTime:
    case MeasurementKind.PositiveWidth:
    case MeasurementKind.NegativeWidth:
    case MeasurementKind.PositiveDuty:
    case MeasurementKind.NegativeDuty:
    case MeasurementKind.Tvmax:
    case MeasurementKind.Tvmin:
      return value;
    default:
      throw new Error("Invalid measurement kind");
  }
}

function readControl(value: unknown): ControlChange {
  if (!isRecord(value)) throw new Error("control must be an object");
  switch (value.kind) {
    case ControlKind.ChannelEnabled:
      if (typeof value.value !== "boolean") throw new Error("Channel enabled value must be boolean");
      return { kind: ControlKind.ChannelEnabled, channel: readChannel(value.channel), value: value.value };
    case ControlKind.ChannelScale:
      return { kind: ControlKind.ChannelScale, channel: readChannel(value.channel), value: readFiniteNumber(value.value, "Channel scale") };
    case ControlKind.ChannelOffset:
      return { kind: ControlKind.ChannelOffset, channel: readChannel(value.channel), value: readFiniteNumber(value.value, "Channel offset") };
    case ControlKind.ChannelCoupling:
      return { kind: ControlKind.ChannelCoupling, channel: readChannel(value.channel), value: readChannelCoupling(value.value) };
    case ControlKind.ChannelProbeRatio:
      return { kind: ControlKind.ChannelProbeRatio, channel: readChannel(value.channel), value: readFiniteNumber(value.value, "Probe ratio") };
    case ControlKind.ChannelBandwidthLimit:
      return { kind: ControlKind.ChannelBandwidthLimit, channel: readChannel(value.channel), value: readChannelBandwidthLimit(value.value) };
    case ControlKind.MathEnabled:
      if (typeof value.value !== "boolean") throw new Error("Math enabled value must be boolean");
      return { kind: ControlKind.MathEnabled, math: readMathChannel(value.math), value: value.value };
    case ControlKind.MathOperator:
      return { kind: ControlKind.MathOperator, math: readMathChannel(value.math), value: readMathOperator(value.value) };
    case ControlKind.MathSource1:
      return { kind: ControlKind.MathSource1, math: readMathChannel(value.math), value: readMathSource(value.value) };
    case ControlKind.MathSource2:
      return { kind: ControlKind.MathSource2, math: readMathChannel(value.math), value: readMathSource(value.value) };
    case ControlKind.MathScale:
      return { kind: ControlKind.MathScale, math: readMathChannel(value.math), value: readFiniteNumber(value.value, "Math scale") };
    case ControlKind.MathOffset:
      return { kind: ControlKind.MathOffset, math: readMathChannel(value.math), value: readFiniteNumber(value.value, "Math offset") };
    case ControlKind.HorizontalScale:
      return { kind: ControlKind.HorizontalScale, value: readFiniteNumber(value.value, "Horizontal scale") };
    case ControlKind.HorizontalPosition:
      return { kind: ControlKind.HorizontalPosition, value: readFiniteNumber(value.value, "Horizontal position") };
    case ControlKind.HorizontalMode:
      return { kind: ControlKind.HorizontalMode, value: readTimebaseMode(value.value) };
    case ControlKind.AcquisitionType:
      return { kind: ControlKind.AcquisitionType, value: readAcquisitionType(value.value) };
    case ControlKind.AcquisitionAverages:
      return { kind: ControlKind.AcquisitionAverages, value: readPositiveInteger(value.value, "Acquisition averages") };
    case ControlKind.AcquisitionMemoryDepth:
      return { kind: ControlKind.AcquisitionMemoryDepth, value: readPositiveInteger(value.value, "Acquisition memory depth") };
    case ControlKind.TriggerLevel:
      return { kind: ControlKind.TriggerLevel, value: readFiniteNumber(value.value, "Trigger level") };
    case ControlKind.TriggerType:
      if (value.value !== TriggerType.Edge) throw new Error("Only TriggerType.Edge is writable");
      return { kind: ControlKind.TriggerType, value: TriggerType.Edge };
    case ControlKind.TriggerSource:
      return { kind: ControlKind.TriggerSource, value: readChannel(value.value) };
    case ControlKind.TriggerSlope:
      return { kind: ControlKind.TriggerSlope, value: readEdgeSlope(value.value) };
    case ControlKind.TriggerSweep:
      return { kind: ControlKind.TriggerSweep, value: readTriggerSweep(value.value) };
    case ControlKind.TriggerCoupling:
      return { kind: ControlKind.TriggerCoupling, value: readTriggerCoupling(value.value) };
    default:
      throw new Error("Unknown control kind");
  }
}

function readInteractiveControl(value: unknown): InteractiveControl {
  const control = readControl(value);
  switch (control.kind) {
    case ControlKind.ChannelScale:
    case ControlKind.ChannelOffset:
    case ControlKind.HorizontalScale:
    case ControlKind.HorizontalPosition:
    case ControlKind.TriggerLevel:
      return control;
    default:
      throw new Error("Control is not interactive");
  }
}

function readMeasurements(value: unknown): NonEmptyArray<MeasurementSpec> {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("measurements must contain at least one item");
  }
  return readMeasurementList(value) as NonEmptyArray<MeasurementSpec>;
}

function readMeasurementList(value: unknown): MeasurementSpec[] {
  if (!Array.isArray(value)) throw new Error("measurements must be an array");
  return value.map((item): MeasurementSpec => {
    if (!isRecord(item)) throw new Error("measurement must be an object");
    return { kind: readMeasurementKind(item.kind), channel: readWaveformSource(item.channel) };
  });
}

function readAcquisitionAction(value: unknown): AcquisitionAction {
  switch (value) {
    case AcquisitionAction.Run:
    case AcquisitionAction.Stop:
    case AcquisitionAction.Single:
      return value;
    default:
      throw new Error("Invalid acquisition action");
  }
}

function readViewportRequest(value: Record<string, unknown>): WaveformViewportRequestMessage {
  const startSample = readNonNegativeInteger(value.startSample, "startSample");
  const endSample = readPositiveInteger(value.endSample, "endSample");
  if (endSample <= startSample) throw new Error("endSample must be greater than startSample");
  return {
    type: MessageType.WaveformViewportRequest,
    requestId: readRequestId(value.requestId),
    captureId: readPositiveInteger(value.captureId, "captureId"),
    channel: readChannel(value.channel),
    startSample,
    endSample,
    pixelWidth: readPositiveInteger(value.pixelWidth, "pixelWidth"),
  };
}

function readWaveformHeader(frame: Uint8Array): WaveformHeader {
  if (frame.byteLength < WAVEFORM_HEADER_BYTES) throw new Error("Waveform frame is shorter than its header");
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  if (view.getUint32(0, true) !== WAVEFORM_MAGIC) throw new Error("Waveform frame has invalid magic");
  if (view.getUint8(4) !== WAVEFORM_FRAME_VERSION) throw new Error("Waveform frame has unsupported version");
  const kind = view.getUint8(5);
  if (kind !== WaveformKind.Live && kind !== WaveformKind.DeepViewport) {
    throw new Error("Waveform frame has invalid kind");
  }
  const source = readWaveformSource(view.getUint8(6));
  if (kind === WaveformKind.DeepViewport && source > WaveformSource.Ch4) {
    throw new Error("Deep waveform frame has non-physical source");
  }
  if (view.getUint32(28, true) !== WAVEFORM_HEADER_BYTES) {
    throw new Error("Waveform frame has invalid header length");
  }
  return { kind, source, captureId: view.getUint32(12, true) };
}
