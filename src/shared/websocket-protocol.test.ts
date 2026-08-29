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
  it("uses the hard-cut DMM snapshot protocol version", () => {
    expect(PROTOCOL_VERSION).toBe(3);
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
      MessageType.CommandCompleted,
      MessageType.CommandFailed,
      MessageType.ScpiResult,
      MessageType.MeasurementResult,
      MessageType.DeepCaptureReady,
    ]).toEqual([1, 2, 3, 10, 11, 12, 13, 14, 15, 16, 17, 20, 21, 22, 23, 24]);

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
  });

  it("keeps instrument identities explicit and stable", () => {
    expect([SupportedInstrument.Dho804, SupportedInstrument.Dm858e]).toEqual([1, 2]);
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
    ]).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
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
