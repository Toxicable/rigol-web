import { describe, expect, it } from "vitest";

import {
  AcquisitionType,
  Channel,
  ChannelCoupling,
  ChannelUnit,
  EdgeSlope,
  MeasurementKind,
  ScopeRunState,
  TimebaseMode,
  TriggerCoupling,
  TriggerSweep,
  TriggerType,
} from "./scope-types";

describe("scope domain enum values", () => {
  it("keeps channel values stable", () => {
    expect([Channel.Ch1, Channel.Ch2, Channel.Ch3, Channel.Ch4]).toEqual([
      1, 2, 3, 4,
    ]);
  });

  it("keeps channel metadata values stable", () => {
    expect([ChannelCoupling.Ac, ChannelCoupling.Dc, ChannelCoupling.Ground]).toEqual([
      1, 2, 3,
    ]);
    expect([
      ChannelUnit.Volts,
      ChannelUnit.Amps,
      ChannelUnit.Watts,
      ChannelUnit.Unknown,
    ]).toEqual([1, 2, 3, 4]);
  });

  it("keeps acquisition and horizontal values stable", () => {
    expect([TimebaseMode.Main, TimebaseMode.Roll, TimebaseMode.Xy]).toEqual([
      1, 2, 3,
    ]);
    expect([
      AcquisitionType.Normal,
      AcquisitionType.Peak,
      AcquisitionType.Average,
      AcquisitionType.Ultra,
    ]).toEqual([1, 2, 3, 4]);
    expect([
      ScopeRunState.Triggered,
      ScopeRunState.Waiting,
      ScopeRunState.Running,
      ScopeRunState.Auto,
      ScopeRunState.Stopped,
    ]).toEqual([1, 2, 3, 4, 5]);
  });

  it("keeps trigger values stable", () => {
    expect([
      TriggerType.Edge,
      TriggerType.Pulse,
      TriggerType.Slope,
      TriggerType.Video,
      TriggerType.Pattern,
      TriggerType.Duration,
      TriggerType.Timeout,
      TriggerType.Runt,
      TriggerType.Window,
      TriggerType.Delay,
      TriggerType.SetupHold,
      TriggerType.NthEdge,
      TriggerType.Rs232,
      TriggerType.I2c,
      TriggerType.Spi,
      TriggerType.Can,
    ]).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
    expect([TriggerSweep.Auto, TriggerSweep.Normal, TriggerSweep.Single]).toEqual([
      1, 2, 3,
    ]);
    expect([EdgeSlope.Rising, EdgeSlope.Falling, EdgeSlope.Either]).toEqual([
      1, 2, 3,
    ]);
    expect([
      TriggerCoupling.Ac,
      TriggerCoupling.Dc,
      TriggerCoupling.LowFrequencyReject,
      TriggerCoupling.HighFrequencyReject,
    ]).toEqual([1, 2, 3, 4]);
  });

  it("keeps measurement values stable", () => {
    expect([
      MeasurementKind.Vpp,
      MeasurementKind.Vmax,
      MeasurementKind.Vmin,
      MeasurementKind.Vavg,
      MeasurementKind.Vrms,
      MeasurementKind.Frequency,
      MeasurementKind.Period,
    ]).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });
});
