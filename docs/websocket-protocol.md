# WebSocket Protocol

## Overview

Rigol Web uses one persistent WebSocket connection between each browser tab and the server.

Protocol version 4 supports exactly two instrument identities:

```ts
export enum SupportedInstrument {
  Dho804 = 1,
  Dm858e = 2,
}
```

The protocol is application-specific, not a generic RPC or plugin protocol.

Use:

- JSON for protocol handshake, subscriptions, lifecycle, state, DMM snapshots, control, results and errors;
- binary frames only for DHO804 waveform sample payloads.

Protocol discriminants and fixed values use numeric TypeScript enums. Object field names remain descriptive.

## Protocol version

```ts
export const PROTOCOL_VERSION = 4;
```

Version 4 is a hard-cut change from version 3 because every numeric DMM latest-reading snapshot now carries a required positive `resolution` quantum from the same authoritative measurement observation. Browser formatting rounds to that quantum instead of reconstructing precision from rate, digit class or Auto-range state. Old browser/server bundles must therefore fail the hello version check rather than silently mixing snapshot shapes.

Version 3 introduced the latest-reading snapshot contract, explicit non-applicable DMM controls and function-bound DMM controls. Version 2 introduced instrument subscriptions, explicit raw-SCPI targets and DM858E lifecycle/control messages.

Do not renumber existing message values when changing names or adding messages unless a deliberate protocol break requires it.

## Application-level hello

The server sends a version hello immediately after accepting `/ws`:

```ts
interface ProtocolHelloMessage {
  type: MessageType.ProtocolHello; // 25
  protocolVersion: number;
}
```

The browser must require exact equality with `PROTOCOL_VERSION` and reply:

```ts
interface ProtocolHelloAckMessage {
  type: MessageType.ProtocolHelloAck; // 26
  protocolVersion: number;
}
```

The server rejects non-handshake application messages until a valid acknowledgement arrives. A mismatch closes the socket clearly.

## Message types

```ts
export enum MessageType {
  ScopeConnected = 1,
  ScopeState = 2,
  ScopeDisconnected = 3,

  ControlSet = 10,
  InteractionUpdate = 11,
  InteractionCommit = 12,
  AcquisitionAction = 13,
  DeepCaptureRequest = 14,
  WaveformViewportRequest = 15,
  ScpiExecute = 16,
  MeasurementRead = 17,

  CommandCompleted = 20,
  CommandFailed = 21,
  ScpiResult = 22,
  MeasurementResult = 23,
  DeepCaptureReady = 24,
  ProtocolHello = 25,
  ProtocolHelloAck = 26,

  InstrumentSubscribe = 30,
  InstrumentUnsubscribe = 31,

  DmmConnected = 40,
  DmmState = 41,
  DmmDisconnected = 42,
  DmmSnapshot = 43,

  DmmControlSet = 50,
}
```

## Instrument subscriptions

After the hello handshake the browser explicitly subscribes to the instrument owned by its current route:

```ts
interface InstrumentSubscribeMessage {
  type: MessageType.InstrumentSubscribe;
  instrument: SupportedInstrument;
}

interface InstrumentUnsubscribeMessage {
  type: MessageType.InstrumentUnsubscribe;
  instrument: SupportedInstrument;
}
```

These messages do not use request IDs. The observable result is the corresponding instrument lifecycle stream.

Server behaviour:

- only subscribed browser sessions receive that instrument's lifecycle/state/data;
- scope commands require a DHO804 subscription;
- DMM commands require a DM858E subscription;
- `ScpiExecute` requires a subscription to its explicit target;
- closing the browser WebSocket releases all subscriptions owned by that session.

Multiple tabs may subscribe to the same instrument and share its one active server runtime.

## Scope lifecycle

DHO804 lifecycle remains separate from DMM lifecycle:

```ts
type ScopeLifecycleMessage =
  | {
      type: MessageType.ScopeConnected;
      protocolVersion: number;
      info: ScopeInfo;
      state: ScopeState;
    }
  | {
      type: MessageType.ScopeState;
      state: ScopeState;
    }
  | {
      type: MessageType.ScopeDisconnected;
      reason: string;
    };
```

`ScopeConnected` is not published until DHO804 identity is verified and a complete initial `ScopeState` has been read. The server sends complete authoritative `ScopeState` snapshots rather than partial patches.

## DMM lifecycle and latest-reading snapshots

Shared DMM domain types live in `src/shared/dmm-types.ts`.

```ts
type DmmLifecycleMessage =
  | {
      type: MessageType.DmmConnected;
      protocolVersion: number;
      info: DmmInfo;
      state: DmmState;
    }
  | {
      type: MessageType.DmmState;
      state: DmmState;
    }
  | {
      type: MessageType.DmmDisconnected;
      reason: string;
    }
  | {
      type: MessageType.DmmSnapshot;
      snapshot: DmmReadingSnapshot;
    };
```

`DmmState` is authoritative configuration/control state. Range and acquisition rate explicitly represent non-applicability:

```ts
interface DmmState {
  function: DmmMeasurementFunction;
  range: DmmRange | null;
  acquisitionRate: DmmAcquisitionRate | null;
}
```

A `null` field means the selected function does not expose that control. It is not Auto, not a retained prior value, and must not be shown as an active authoritative control value.

`DmmSnapshot` is the current display snapshot. It deliberately has **no sequence number** and is not a sample event:

```ts
type DmmReadingSnapshot =
  | {
      kind: DmmReadingKind.Value;
      function: DmmMeasurementFunction;
      value: number;
      resolution: number;
      unit: DmmUnit;
    }
  | {
      kind: DmmReadingKind.Overload;
      function: DmmMeasurementFunction;
      unit: DmmUnit;
    }
  | {
      kind: DmmReadingKind.Unavailable;
      function: DmmMeasurementFunction;
      unit: DmmUnit;
      reason: DmmReadingUnavailableReason;
    };
```

For `Value`, `resolution` is a positive finite measurement quantum authoritative for that observation. It is not a display hint or a digit-count estimate. The browser rounds the numeric value to this quantum before engineering-prefix formatting and must not infer a finer precision from `DmmState`. This is required for fixed ranges such as 100 V Fast (`0.1 V` resolution) and for Auto range where `DmmState.range` intentionally remains `{ mode: Auto }` and does not expose the effective physical range.

If the backend cannot establish an authoritative numeric resolution for the stable observation, it sends `Unavailable/ResolutionUnavailable` rather than a numeric `Value` with guessed precision.

Snapshot polling must not be used to derive sample count, statistics or a measurement timeline. A future sample-stream contract requires a verified one-event-per-physical-measurement acquisition boundary.

`Unavailable` explicitly replaces a prior valid display when the backend knows no current usable value is available. The DM858E backend uses `NoData` for the documented bare `DATA:LAST?` no-data sentinel, `UnclassifiedSentinel` when a sentinel-sized response has no documented overload meaning, `ConfigurationChanged` when the observation/configuration context is stale, and `ResolutionUnavailable` when a safe numeric display quantum is not available.

## DHO804 controls

Scope control kinds remain numeric:

```ts
export enum ControlKind {
  ChannelEnabled = 1,
  ChannelScale = 2,
  ChannelOffset = 3,
  HorizontalScale = 4,
  HorizontalPosition = 5,
  TriggerLevel = 6,
  TriggerType = 7,
  TriggerSource = 8,
  TriggerSlope = 9,
}
```

Use the typed `ControlChange` union from shared code rather than arbitrary property paths.

Discrete changes use `ControlSetMessage`. Continuous interaction updates are disposable and carry no request ID; final interaction commits carry a request ID.

## DHO804 acquisition actions

```ts
export enum AcquisitionAction {
  Run = 1,
  Stop = 2,
  Single = 3,
}
```

These actions are DHO804-only and require a DHO804 subscription.

## DMM controls

```ts
export enum DmmControlKind {
  Function = 1,
  Range = 2,
  AcquisitionRate = 3,
}
```

The browser sends:

```ts
interface DmmControlSetMessage {
  type: MessageType.DmmControlSet;
  requestId: number;
  control: DmmControlChange;
}
```

Function-dependent controls carry the function under which the UI created the value:

```ts
type DmmControlChange =
  | {
      kind: DmmControlKind.Function;
      value: DmmMeasurementFunction;
    }
  | {
      kind: DmmControlKind.Range;
      function: DmmMeasurementFunction;
      value: DmmRange;
    }
  | {
      kind: DmmControlKind.AcquisitionRate;
      function: DmmMeasurementFunction;
      value: DmmAcquisitionRate;
    };
```

The backend validates that expected function against authoritative physical state before writing. A stale request fails rather than being reinterpreted under a newly selected function.

The exact DM858E SCPI mapping belongs to the backend driver; the wire protocol carries typed domain values, not Rigol response strings.

## DHO804 measurements

Measurements remain explicit request/result data outside `ScopeState`:

```ts
interface MeasurementReadMessage {
  type: MessageType.MeasurementRead;
  requestId: number;
  measurements: NonEmptyArray<MeasurementSpec>;
}

interface MeasurementResultMessage {
  type: MessageType.MeasurementResult;
  requestId: number;
  values: MeasurementValue[];
}
```

Requests must be non-empty. Values are returned in request order. Any failed requested measurement fails the request rather than returning a partial optional result.

## Raw SCPI

Raw SCPI is explicitly instrument-targeted:

```ts
interface ScpiExecuteMessage {
  type: MessageType.ScpiExecute;
  requestId: number;
  instrument: SupportedInstrument;
  command: string;
}

interface ScpiResultMessage {
  type: MessageType.ScpiResult;
  requestId: number;
  response: string;
}
```

There is no implicit DHO804 default. The gateway routes the request through the selected instrument's normal scheduler/runtime serialization.

Program-message validation and command/query classification are shared generic SCPI infrastructure; instrument drivers do not maintain private query scanners.

For a successful command with no text response, `response` is the empty string. If a raw query produces a binary block while the console only supports text, the transport must consume the complete block safely before reporting a clear console failure.

## DHO804 deep capture

```ts
interface DeepCaptureRequestMessage {
  type: MessageType.DeepCaptureRequest;
  requestId: number;
}
```

On success `DeepCaptureReadyMessage` returns a positive `captureId` and a non-empty channel list describing sample count and X-axis scaling.

## DHO804 deep viewport requests

Viewport ranges are zero-based and half-open. A successful request returns a `WaveformKind.DeepViewport` binary frame described in `waveform-protocol.md`. A newer request supersedes an older pending viewport for the same channel.

## Command completion

Messages with request IDs receive either a typed result, completion or failure:

```ts
type CommandResult =
  | {
      type: MessageType.CommandCompleted;
      requestId: number;
    }
  | {
      type: MessageType.CommandFailed;
      requestId: number;
      error: string;
    };
```

Use typed result messages for measurements, deep-capture completion and raw SCPI responses.

## DHO804 binary waveforms

Binary waveform frames are separate from `ServerJsonMessage` and use the fixed format in `waveform-protocol.md`.

```ts
export enum WaveformKind {
  Live = 1,
  DeepViewport = 2,
}
```

Live frames are sent only to DHO804-subscribed sessions and are disposable under backpressure.

## Client and server unions

Conceptually:

```ts
type ClientMessage =
  | ProtocolHelloAckMessage
  | InstrumentSubscribeMessage
  | InstrumentUnsubscribeMessage
  | ControlSetMessage
  | InteractionUpdateMessage
  | InteractionCommitMessage
  | AcquisitionActionMessage
  | DeepCaptureRequestMessage
  | WaveformViewportRequestMessage
  | ScpiExecuteMessage
  | MeasurementReadMessage
  | DmmControlSetMessage;

type ServerJsonMessage =
  | ProtocolHelloMessage
  | ScopeLifecycleMessage
  | DmmLifecycleMessage
  | CommandResult
  | ScpiResultMessage
  | MeasurementResultMessage
  | DeepCaptureReadyMessage;
```

## JSON validation

Validate WebSocket JSON structurally before application dispatch.

Reject at least:

- unknown message types;
- application traffic before handshake;
- mismatched protocol version;
- unsupported instrument identity;
- missing required fields;
- non-finite numeric controls;
- out-of-range enum values;
- request IDs that are not non-negative integers;
- invalid viewport ranges;
- empty measurement requests;
- invalid DMM fixed ranges;
- function-dependent DMM controls missing a valid expected function.

Malformed data must not become partially populated application objects.

## Backpressure

JSON lifecycle/control/error traffic is more important than stale DHO804 live waveform frames. Do not allow a slow browser to create an unbounded waveform queue. Prefer latest-frame replacement while preserving JSON traffic.

## Non-goals

Do not add without a concrete requirement:

- generic RPC;
- GraphQL;
- REST control endpoints;
- arbitrary instrument discovery/selection;
- generic plugin protocols;
- per-feature subscriptions inside one instrument;
- partial-patch protocols for `ScopeState` or `DmmState`;
- exclusive browser ownership/locking of an instrument.
