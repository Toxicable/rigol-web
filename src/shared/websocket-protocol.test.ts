import { describe, expect, it } from "vitest";

import { DmmControlKind } from "./dmm-types.js";
import { SupportedInstrument } from "./instrument-types.js";
import {
  AcquisitionAction,
  ControlKind,
  MessageType,
  PROTOCOL_VERSION,
  WaveformKind,
} from "./websocket-protocol";

describe("websocket protocol constants", () => {
  it("uses the PPK2 integration protocol version", () => {
    expect(PROTOCOL_VERSION).toBe(10);
  });

  it("keeps existing message type values stable and assigns instrument ranges", () => {
    expect([
      MessageType.ScopeConnected,
      MessageType.ScopeState,
      MessageType.ScopeDisconnected,
      MessageType.ControlSet,
      MessageType.InteractionUpdate,
      MessageType.InteractionCommit,
      MessageType.AcquisitionAction,
      MessageType.DeepCaptureRequest,
      MessageType.WaveformViewportRequest,
      MessageType.ScpiExecute,
      MessageType.MeasurementRead,
      MessageType.MeasurementSet,
      MessageType.ScopeSleep,
      MessageType.CommandCompleted,
      MessageType.CommandFailed,
      MessageType.ScpiResult,
      MessageType.MeasurementResult,
      MessageType.DeepCaptureReady,
    ]).toEqual([1, 2, 3, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24]);

    expect([
      MessageType.ProtocolHello,
      MessageType.ProtocolHelloAck,
      MessageType.InstrumentSubscribe,
      MessageType.InstrumentUnsubscribe,
      MessageType.DmmConnected,
      MessageType.DmmState,
      MessageType.DmmDisconnected,
      MessageType.DmmSnapshot,
      MessageType.DmmControlSet,
    ]).toEqual([25, 26, 30, 31, 40, 41, 42, 43, 50]);

    expect([
      MessageType.AcquisitionOperationStart,
      MessageType.AcquisitionOperationStop,
      MessageType.AcquisitionOperationGet,
      MessageType.AcquisitionOperationList,
      MessageType.AcquisitionOperationResult,
      MessageType.AcquisitionOperationListResult,
    ]).toEqual([60, 61, 62, 63, 64, 65]);

    expect([
      MessageType.Ppk2Connected,
      MessageType.Ppk2Disconnected,
      MessageType.Ppk2Stats,
      MessageType.Ppk2Live,
      MessageType.Ppk2CaptureStart,
      MessageType.Ppk2CaptureStop,
      MessageType.Ppk2ViewportRequest,
      MessageType.Ppk2ViewportResult,
    ]).toEqual([70, 71, 72, 73, 74, 75, 76, 77]);
  });

  it("keeps instrument identities explicit and stable", () => {
    expect([
      SupportedInstrument.Dho804,
      SupportedInstrument.Dm858e,
      SupportedInstrument.Ppk2,
    ]).toEqual([1, 2, 3]);
  });

  it("keeps control values stable", () => {
    expect([
      ControlKind.ChannelEnabled,
      ControlKind.ChannelScale,
      ControlKind.ChannelOffset,
      ControlKind.HorizontalScale,
      ControlKind.HorizontalPosition,
      ControlKind.TriggerLevel,
      ControlKind.TriggerType,
      ControlKind.TriggerSource,
      ControlKind.TriggerSlope,
      ControlKind.ChannelCoupling,
      ControlKind.ChannelProbeRatio,
      ControlKind.HorizontalMode,
      ControlKind.TriggerSweep,
      ControlKind.TriggerCoupling,
      ControlKind.AcquisitionType,
      ControlKind.AcquisitionAverages,
      ControlKind.AcquisitionMemoryDepth,
      ControlKind.ChannelBandwidthLimit,
    ]).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]);
    expect([
      DmmControlKind.Function,
      DmmControlKind.Range,
      DmmControlKind.AcquisitionRate,
    ]).toEqual([1, 2, 3]);
  });

  it("keeps acquisition action and waveform kind values stable", () => {
    expect([
      AcquisitionAction.Run,
      AcquisitionAction.Stop,
      AcquisitionAction.Single,
    ]).toEqual([1, 2, 3]);
    expect([WaveformKind.Live, WaveformKind.DeepViewport]).toEqual([1, 2]);
  });
});
