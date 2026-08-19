# WebSocket Protocol

## Overview

Rigol Web uses one persistent WebSocket connection between the browser and server.

The protocol is intentionally application-specific rather than a generic RPC framework.

Use:

- JSON for control, state, lifecycle and error messages
- binary frames for waveform sample payloads

HTTP is only needed for application assets and simple endpoints such as `/health`.

Protocol discriminants and fixed protocol values use actual numeric TypeScript enums. Property names remain descriptive.

TypeScript conventions are documented in `typescript-practices.md`. The authoritative connected-scope model is documented in `scope-model.md`.

## Message types

Assign protocol enum values explicitly and keep them stable once used on the wire.

The initial message space can be grouped for readability:

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

  CommandCompleted = 20,
  CommandFailed = 21,
  ScpiResult = 22,
}
```

Do not use string discriminants such as `"interaction.update"` or `"scope.state"` on the wire.

## State delivery

The server sends complete authoritative `ScopeState` snapshots rather than `Partial<ScopeState>` patches.

The state object is small, the application runs on a local network, and full snapshots avoid patch-merging ambiguity and optional-field-heavy types.

`ScopeState` and `ScopeInfo` are defined by `scope-model.md`; the protocol should import those shared types rather than recreate them.

Conceptually:

```ts
type ServerMessage =
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
    }
  | CommandResult
  | ScpiResultMessage;
```

## Client commands

Use explicit discriminated unions for commands.

Do not use generic string property paths such as `channels.0.offset`.

Conceptually:

```ts
type ClientMessage =
  | ControlSetMessage
  | InteractionUpdateMessage
  | InteractionCommitMessage
  | AcquisitionActionMessage
  | DeepCaptureRequestMessage
  | WaveformViewportRequestMessage
  | ScpiExecuteMessage;
```

Control kinds are also numeric enums rather than string paths:

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

The initial `TriggerType` control is required so the UI can explicitly select Edge trigger after the physical scope or another SCPI client has selected another trigger type. Version 1 only needs to offer Edge as a writable trigger type even though `ScopeState` can report the other DHO804 trigger types.

The exact control set grows with implemented scope features. The protocol should keep semantic control variants rather than accepting arbitrary object paths.

## Discrete control changes

Ordinary controls use request IDs so completion or failure can be associated with the originating operation.

```ts
interface ControlSetMessage {
  type: MessageType.ControlSet;
  requestId: number;
  control: ControlChange;
}
```

`ControlChange` should be an explicit discriminated union whose payload type matches the corresponding domain type from `scope-model.md`. For example, trigger source uses `Channel`, trigger slope uses `EdgeSlope`, and trigger type uses `TriggerType`; do not send their SCPI string spellings over the WebSocket.

## Continuous interactions

Intermediate drag updates are intentionally disposable and coalescible.

They do not need a request ID or acknowledgement for every intermediate value.

```ts
interface InteractionUpdateMessage {
  type: MessageType.InteractionUpdate;
  control: InteractiveControl;
}
```

The final value is sent separately as an interaction commit:

```ts
interface InteractionCommitMessage {
  type: MessageType.InteractionCommit;
  requestId: number;
  control: InteractiveControl;
}
```

The server schedules the committed value at highest priority and performs authoritative readback afterwards.

## Acquisition actions

Use a numeric enum for the action itself:

```ts
export enum AcquisitionAction {
  Run = 1,
  Stop = 2,
  Single = 3,
}

interface AcquisitionActionMessage {
  type: MessageType.AcquisitionAction;
  requestId: number;
  action: AcquisitionAction;
}
```

These map to the DHO804 root `:RUN`, `:STOP` and `:SINGle` commands. They are actions, not direct writes to `ScopeRunState`.

## Command completion

Messages with a `requestId` receive a completion or failure response where an explicit result is useful.

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

The UI should remain optimistic where appropriate and should not generally block interaction waiting for `CommandCompleted`.

## Raw SCPI console

The SCPI console uses explicit request/response messages and is not a bypass around the scheduler.

```ts
interface ScpiExecuteMessage {
  type: MessageType.ScpiExecute;
  requestId: number;
  command: string;
}

interface ScpiResultMessage {
  type: MessageType.ScpiResult;
  requestId: number;
  response: string;
}
```

Raw console commands still pass through the normal serialized SCPI path so they cannot corrupt query/response framing.

## Live waveforms

Live waveform samples are sent as binary frames.

Binary headers should also use numeric fixed values rather than serialized strings, for example:

```ts
export enum WaveformKind {
  Live = 1,
  DeepViewport = 2,
}
```

Live frames should contain enough fixed metadata to identify and scale the payload, including:

- frame/version marker
- waveform kind
- channel
- sequence number
- sample count
- X increment/origin/reference
- Y increment/origin/reference
- sample representation

The exact binary header layout should be defined during implementation and versioned explicitly.

Live waveform frames are disposable. When backpressure occurs, prefer the newest available frame.

## Deep captures

The server owns the full deep capture. The browser does not normally receive the complete raw acquisition.

Deep-capture lifecycle/control messages are JSON using numeric message discriminants.

The browser requests display-resolution viewport data by capture ID, sample range and pixel width.

The corresponding sample payload is returned as a binary frame using `WaveformKind.DeepViewport`.

See `waveforms.md` for downsampling and overscan behaviour.

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

Do not compress ordinary protocol messages into positional arrays merely to save a few additional bytes.

## Protocol versioning

The connection handshake includes an integer protocol version.

Do not build a complex negotiation system initially. If browser and server protocol versions are incompatible, fail clearly rather than guessing.

## Backpressure

Control, state and error messages are more important than stale live waveform frames.

Do not allow a slow browser to create an unbounded outgoing waveform queue.

Prefer:

- bounded output buffering
- stale waveform replacement
- preservation of control/state/error messages

## Non-goals

Do not introduce, unless a concrete future requirement appears:

- GraphQL
- generic RPC
- REST control endpoints
- authentication/session ownership machinery
- subscriptions per scope feature
- patch protocols for `ScopeState`

The protocol should remain explicit, typed and small.
