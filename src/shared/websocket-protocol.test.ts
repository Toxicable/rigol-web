import { describe, expect, it } from "vitest";

import {
  AcquisitionAction,
  ControlKind,
  MessageType,
  PROTOCOL_VERSION,
  WaveformKind,
} from "./websocket-protocol";

describe("websocket protocol constants", () => {
  it("keeps protocol version stable", () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });

  it("keeps message type values stable", () => {
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
