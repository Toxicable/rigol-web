# WebSocket Protocol

## Overview

Rigol Web uses one persistent WebSocket connection between the browser and server.

The protocol is intentionally application-specific rather than a generic RPC framework.

Use:

- JSON for control, state, lifecycle, measurement and error messages
- binary frames for waveform sample payloads

HTTP is only needed for application assets and simple endpoints such as `/health`.

Protocol discriminants and fixed protocol values use actual numeric TypeScript enums. Property names remain descriptive.

TypeScript conventions are documented in `typescript-practices.md`. The authoritative connected-scope model is documented in `scope-model.md`. The byte-for-byte waveform format is documented in `waveform-protocol.md`.

## Message types

Assign protocol enum values explicitly and keep them stable once used on the wire.

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
}
```

Do not renumber existing values when adding future message kinds.

Do not use string discriminants such as `"interaction.update"` or `"scope.state"` on the wire.

## State delivery

The server sends complete authoritative `ScopeState` snapshots rather than `Partial<ScopeState>` patches.

The state object is small, the application runs on a local network, and full snapshots avoid patch-merging ambiguity and optional-field-heavy types.

`ScopeState` and `ScopeInfo` are defined by `scope-model.md`; the protocol imports those shared types rather than recreating them.

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

`ScopeConnected` is not sent until identity has been verified as DHO804 and a complete initial `ScopeState` has been read.

## Control kinds

Control kinds are numeric enums rather than string property paths:

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

The initial `TriggerType` control exists so the UI can explicitly select Edge trigger after the physical scope or another SCPI client has selected another trigger type. Version 1 only needs to accept `TriggerType.Edge` as a writable trigger type even though `ScopeState` can report the other DHO804 trigger types.

## Control payloads

Use explicit discriminated unions. Do not use arbitrary string paths such as `channels.0.offset` and do not use an untyped `value: unknown`.

```ts
export type ControlChange =
  | {
      kind: ControlKind.ChannelEnabled;
      channel: Channel;
      value: boolean;
    }
  | {
      kind: ControlKind.ChannelScale;
      channel: Channel;
      value: number;
    }
  | {
      kind: ControlKind.ChannelOffset;
      channel: Channel;
      value: number;
    }
  | {
      kind: ControlKind.HorizontalScale;
      value: number;
    }
  | {
      kind: ControlKind.HorizontalPosition;
      value: number;
    }
  | {
      kind: ControlKind.TriggerLevel;
      value: number;
    }
  | {
      kind: ControlKind.TriggerType;
      value: TriggerType;
    }
  | {
      kind: ControlKind.TriggerSource;
      value: Channel;
    }
  | {
      kind: ControlKind.TriggerSlope;
      value: EdgeSlope;
    };
```

All numeric physical values use the units defined in `scope-model.md`.

`InteractiveControl` is the subset that can produce continuous updates:

```ts
export type InteractiveControl =
  | Extract<ControlChange, { kind: ControlKind.ChannelScale }>
  | Extract<ControlChange, { kind: ControlKind.ChannelOffset }>
  | Extract<ControlChange, { kind: ControlKind.HorizontalScale }>
  | Extract<ControlChange, { kind: ControlKind.HorizontalPosition }>
  | Extract<ControlChange, { kind: ControlKind.TriggerLevel }>;
```

## Discrete control changes

Ordinary controls and direct numeric-entry changes use request IDs so completion or failure can be associated with the originating operation.

```ts
export interface ControlSetMessage {
  type: MessageType.ControlSet;
  requestId: number;
  control: ControlChange;
}
```

A `ControlSet` for a normally interactive numeric field means a discrete/direct change rather than a pointer-drag stream.

## Continuous interactions

Intermediate drag updates are intentionally disposable and coalescible.

They do not need a request ID or acknowledgement for every intermediate value.

```ts
export interface InteractionUpdateMessage {
  type: MessageType.InteractionUpdate;
  control: InteractiveControl;
}
```

The final value is sent separately as an interaction commit:

```ts
export interface InteractionCommitMessage {
  type: MessageType.InteractionCommit;
  requestId: number;
  control: InteractiveControl;
}
```

The server schedules the committed value at highest priority and performs authoritative readback afterwards.

The browser should not wait for completion before updating the local visual position.

## Acquisition actions

Use a numeric enum for the action itself:

```ts
export enum AcquisitionAction {
  Run = 1,
  Stop = 2,
  Single = 3,
}

export interface AcquisitionActionMessage {
  type: MessageType.AcquisitionAction;
  requestId: number;
  action: AcquisitionAction;
}
```

These map to the DHO804 root `:RUN`, `:STOP` and `:SINGle` commands. They are actions, not direct writes to `ScopeRunState`.

## Measurements

Measurements are explicit request/response work and are not members of `ScopeState`.

The shared `MeasurementKind`, `MeasurementSpec` and `MeasurementValue` types are defined in `scope-model.md`.

```ts
export interface MeasurementReadMessage {
  type: MessageType.MeasurementRead;
  requestId: number;
  measurements: MeasurementSpec[];
}

export interface MeasurementResultMessage {
  type: MessageType.MeasurementResult;
  requestId: number;
  values: MeasurementValue[];
}
```

A measurement request must contain at least one item. The server returns values in the same order as the request.

The frontend can issue a low-rate recurring request containing only the measurements currently displayed. Start conservatively at approximately 1 Hz and benchmark before increasing the rate. These reads are less important than interactive control and should not delay it.

If any requested measurement fails, return `CommandFailed` for the request rather than a partially valid result containing optional/missing values.

## Deep capture

A deep capture request asks the server to capture RAW memory for the channels that are currently enabled on the DHO804.

```ts
export interface DeepCaptureRequestMessage {
  type: MessageType.DeepCaptureRequest;
  requestId: number;
}
```

On success the server returns:

```ts
export interface DeepCaptureChannelInfo {
  channel: Channel;
  sampleCount: number;
}

export interface DeepCaptureReadyMessage {
  type: MessageType.DeepCaptureReady;
  requestId: number;
  captureId: number;
  channels: DeepCaptureChannelInfo[];
}
```

`captureId` is positive. `channels` is non-empty and contains only channels actually retained in the completed capture.

A deep capture is explicit and may take noticeable time. Do not pretend it is preemptible once a native RAW binary transaction is in progress.

The browser then asks for display-sized views of that retained capture.

## Deep viewport requests

Deep viewport requests use zero-based, half-open source sample ranges:

```ts
export interface WaveformViewportRequestMessage {
  type: MessageType.WaveformViewportRequest;
  requestId: number;
  captureId: number;
  channel: Channel;
  startSample: number;
  endSample: number;
  pixelWidth: number;
}
```

The successful response is a `WaveformKind.DeepViewport` binary frame described in `waveform-protocol.md`.

A failed request receives `CommandFailed` with the same `requestId`.

A newer viewport request supersedes an older viewport response that is no longer useful to the browser.

## Command completion

Messages with a `requestId` receive a completion, a typed result, or a failure response.

```ts
export type CommandResult =
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

Use `CommandCompleted` for successful commands that have no richer response payload.

Use the typed result message for measurements, deep-capture completion and SCPI console responses.

The UI should remain optimistic where appropriate and should not generally block interaction waiting for `CommandCompleted`.

## Raw SCPI console

The SCPI console uses explicit request/response messages and is not a bypass around the scheduler.

```ts
export interface ScpiExecuteMessage {
  type: MessageType.ScpiExecute;
  requestId: number;
  command: string;
}

export interface ScpiResultMessage {
  type: MessageType.ScpiResult;
  requestId: number;
  response: string;
}
```

For a command with no text response, `response` is the empty string. It remains required.

Raw console commands still pass through the normal serialized SCPI path so they cannot corrupt query/response framing.

Version 1 of the console is for commands and text queries. If a raw console query produces a binary block, reject it clearly rather than attempting to place arbitrary binary data inside the JSON `response` string. Native waveform reads belong to the waveform services.

## Live waveforms

Live waveform samples are sent as binary frames using:

```ts
export enum WaveformKind {
  Live = 1,
  DeepViewport = 2,
}
```

The exact 64-byte header and indexed Float32 payload are defined in `waveform-protocol.md`.

Live waveform frames are disposable. When backpressure occurs, prefer the newest available frame.

## Client message union

Conceptually:

```ts
export type ClientMessage =
  | ControlSetMessage
  | InteractionUpdateMessage
  | InteractionCommitMessage
  | AcquisitionActionMessage
  | DeepCaptureRequestMessage
  | WaveformViewportRequestMessage
  | ScpiExecuteMessage
  | MeasurementReadMessage;
```

## Server message union

Conceptually:

```ts
export type ServerJsonMessage =
  | ScopeLifecycleMessage
  | CommandResult
  | ScpiResultMessage
  | MeasurementResultMessage
  | DeepCaptureReadyMessage;
```

Binary waveform frames are handled separately from `ServerJsonMessage`.

## Protocol representation

Numeric enums reduce repeated string values without making the protocol opaque.

Keep descriptive object keys:

```json
{
  "type": 11,
  "control": {
    "kind": 3,
    "channel": 1,
    "value": 0.42
  }
}
```

Do not compress ordinary JSON protocol messages into positional arrays merely to save a few additional bytes.

## Protocol versioning

Define `PROTOCOL_VERSION = 1` in shared code.

`ScopeConnected.protocolVersion` carries that value.

Do not build a complex negotiation system initially. If browser and server protocol versions are incompatible, fail clearly rather than guessing.

## JSON validation

WebSocket input is untrusted transport data even on a local network and must be structurally validated before it reaches application code.

Do not add a heavy runtime schema framework merely for this. Small explicit type/field checks are sufficient for the initial protocol.

Validation should reject:

- unknown message type values
- missing required fields
- non-finite numeric control values
- enum values outside their defined numeric range
- request IDs that are not non-negative integers
- invalid deep viewport ranges
- empty measurement requests

Fail the request clearly. Do not convert malformed input into partially populated application objects.

## Backpressure

Control, state and error messages are more important than stale live waveform frames.

Do not allow a slow browser to create an unbounded outgoing waveform queue.

Prefer:

- bounded output buffering
- stale waveform replacement
- preservation of JSON control/state/error messages

The exact waveform replacement rules are documented in `waveform-protocol.md`.

## Non-goals

Do not introduce, unless a concrete future requirement appears:

- GraphQL
- generic RPC
- REST control endpoints
- authentication/session ownership machinery
- subscriptions per scope feature
- partial-patch protocols for `ScopeState`

The protocol should remain explicit, typed and small.
