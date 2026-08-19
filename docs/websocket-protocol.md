# WebSocket Protocol

## Overview

Rigol Web uses one persistent WebSocket connection between the browser and server.

The protocol is intentionally application-specific rather than a generic RPC framework.

Use:

- JSON for control, state, lifecycle and error messages
- binary frames for waveform sample payloads

HTTP is only needed for application assets and simple endpoints such as `/health`.

## State delivery

The server sends complete authoritative `ScopeState` snapshots rather than `Partial<ScopeState>` patches.

The state object is small, the application runs on a local network, and full snapshots avoid patch-merging ambiguity and optional-field-heavy types.

Conceptually:

```ts
type ServerMessage =
  | {
      type: "scope.connected";
      protocolVersion: 1;
      info: ScopeInfo;
      state: ScopeState;
    }
  | {
      type: "scope.state";
      state: ScopeState;
    }
  | {
      type: "scope.disconnected";
      reason: string;
    };
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

## Discrete control changes

Ordinary controls use request IDs so completion or failure can be associated with the originating operation.

```ts
interface ControlSetMessage {
  type: "control.set";
  requestId: number;
  control: ControlChange;
}
```

## Continuous interactions

Intermediate drag updates are intentionally disposable and coalescible.

They do not need a request ID or acknowledgement for every intermediate value.

```ts
interface InteractionUpdateMessage {
  type: "interaction.update";
  control: InteractiveControl;
}
```

The final value is sent separately as an interaction commit:

```ts
interface InteractionCommitMessage {
  type: "interaction.commit";
  requestId: number;
  control: InteractiveControl;
}
```

The server schedules the committed value at highest priority and performs authoritative readback afterwards.

## Acquisition actions

```ts
interface AcquisitionActionMessage {
  type: "acquisition.action";
  requestId: number;
  action: "run" | "stop" | "single";
}
```

## Command completion

Messages with a `requestId` receive a completion or failure response.

```ts
type CommandResult =
  | {
      type: "command.completed";
      requestId: number;
    }
  | {
      type: "command.failed";
      requestId: number;
      error: string;
    };
```

The UI should remain optimistic where appropriate and should not generally block interaction waiting for `command.completed`.

## Raw SCPI console

The SCPI console uses explicit request/response messages and is not a bypass around the scheduler.

```ts
interface ScpiExecuteMessage {
  type: "scpi.execute";
  requestId: number;
  command: string;
}
```

Raw console commands still pass through the normal serialized SCPI path so they cannot corrupt query/response framing.

## Live waveforms

Live waveform samples are sent as binary frames.

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

Deep-capture lifecycle/control messages are JSON.

The browser requests display-resolution viewport data by capture ID, sample range and pixel width.

The corresponding sample payload is returned as a binary frame.

See `waveforms.md` for downsampling and overscan behaviour.

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
