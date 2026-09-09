# WebSocket Protocol

## Overview

Rigol Web uses one persistent WebSocket connection per browser tab. The protocol is application-specific, not generic RPC.

Current protocol version:

```ts
export const PROTOCOL_VERSION = 7;
```

Version 7 is a hard cut. It adds server-owned acquisition-operation lifecycle requests/results. Browser and server bundles must agree exactly during the hello handshake; no compatibility shim is provided.

Supported SCPI instrument identities remain:

```ts
export enum SupportedInstrument {
  Dho804 = 1,
  Dm858e = 2,
}
```

Use JSON for handshake, subscriptions, lifecycle/state, controls, acquisition-operation metadata, results and errors. Binary frames remain DHO804 waveform payloads only.

## Application-level hello

Immediately after `/ws` connection:

```text
server -> ProtocolHello { protocolVersion: 7 }
browser -> ProtocolHelloAck { protocolVersion: 7 }
```

The server rejects application traffic before a matching acknowledgement. A version mismatch closes the connection.

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
  MeasurementSet = 18,
  ScopeSleep = 19,

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

  AcquisitionOperationStart = 60,
  AcquisitionOperationStop = 61,
  AcquisitionOperationGet = 62,
  AcquisitionOperationList = 63,
  AcquisitionOperationResult = 64,
  AcquisitionOperationListResult = 65,
}
```

Existing numeric values stay stable when adding messages.

## Instrument subscriptions

After handshake, route bindings explicitly subscribe/unsubscribe to DHO804 or DM858E publications.

Subscriptions control browser publication fanout only. They do not start/stop physical runtimes and do not own acquisition-operation lifetime.

Scope and DMM commands require the corresponding instrument subscription. Raw SCPI requires a subscription to its explicit target.

Acquisition-operation start/stop/get/list requests are application-level and do **not** require an instrument subscription.

## Server-owned acquisition operations

Protocol version 7 adds:

```ts
interface AcquisitionOperationStartMessage {
  type: MessageType.AcquisitionOperationStart; // 60
  requestId: number;
  label: string;
}

interface AcquisitionOperationStopMessage {
  type: MessageType.AcquisitionOperationStop; // 61
  requestId: number;
  operationId: number;
}

interface AcquisitionOperationGetMessage {
  type: MessageType.AcquisitionOperationGet; // 62
  requestId: number;
  operationId: number;
}

interface AcquisitionOperationListMessage {
  type: MessageType.AcquisitionOperationList; // 63
  requestId: number;
}
```

Success returns either:

```ts
interface AcquisitionOperationResultMessage {
  type: MessageType.AcquisitionOperationResult; // 64
  requestId: number;
  operation: AcquisitionOperation;
}

interface AcquisitionOperationListResultMessage {
  type: MessageType.AcquisitionOperationListResult; // 65
  requestId: number;
  operations: AcquisitionOperation[];
}
```

`AcquisitionOperation` carries ID, label, initiator, start timestamp, state and progress. Progress reports monotonic `receivedItems`, `sourceLostItems` and `lastSequence`.

A browser initiator includes the requesting server-side WebSocket session ID. This metadata does not make the operation session-owned. Closing that socket does not implicitly stop the operation.

Errors use normal `CommandFailed` request framing.

## Scope lifecycle

DHO804 lifecycle messages remain distinct:

```ts
type ScopeLifecycleMessage =
  | { type: MessageType.ScopeConnected; protocolVersion: number; info: ScopeInfo; state: ScopeState }
  | { type: MessageType.ScopeState; state: ScopeState }
  | { type: MessageType.ScopeDisconnected; reason: string };
```

`ScopeConnected` is not published until identity is verified and complete authoritative scope state is available.

## DMM lifecycle and snapshots

DM858E lifecycle messages remain distinct:

```ts
type DmmLifecycleMessage =
  | { type: MessageType.DmmConnected; protocolVersion: number; info: DmmInfo; state: DmmState }
  | { type: MessageType.DmmState; state: DmmState }
  | { type: MessageType.DmmDisconnected; reason: string }
  | { type: MessageType.DmmSnapshot; snapshot: DmmReadingSnapshot };
```

`DmmSnapshot` is current display state, not a uniquely identified physical sample event. It has no sequence number and must not be used as a logging/statistics stream.

## DHO804 controls and interactions

Scope controls use the typed `ControlChange` union and numeric `ControlKind` values 1-9.

Discrete controls use `ControlSet`. Continuous interaction updates are disposable and carry no request ID; the final `InteractionCommit` carries a request ID.

DHO804 acquisition actions remain:

```ts
export enum AcquisitionAction {
  Run = 1,
  Stop = 2,
  Single = 3,
}
```

These are scope instrument actions and are unrelated to the server-owned acquisition-operation lifecycle added in version 7.

## Scope Sleep

`ScopeSleep` remains a typed request with request ID. Success returns `CommandCompleted`; failure returns `CommandFailed`.

## DMM controls

DMM controls use `DmmControlSet` and the typed `DmmControlChange` union. Function-dependent range/rate controls carry the function under which they were created so stale writes can be rejected rather than reinterpreted.

## Measurements, raw SCPI and deep capture

DHO804 measurements use typed request/result messages.

Raw SCPI is explicitly instrument-targeted:

```ts
interface ScpiExecuteMessage {
  type: MessageType.ScpiExecute;
  requestId: number;
  instrument: SupportedInstrument;
  command: string;
}
```

Deep-capture and viewport messages retain the existing DHO804-specific retained-capture model.

## Request completion

Messages with request IDs receive a typed result, `CommandCompleted`, or `CommandFailed`.

The browser `AppConnection` owns request ID allocation/correlation. Acquisition-operation result/list messages participate in that same correlation path.

## DHO804 binary waveforms

Binary waveform frames remain outside `ServerJsonMessage` and use `waveform-protocol.md`.

Live waveform frames are disposable/latest-oriented under backpressure. That behavior must not be reused for loss-sensitive raw acquisition streams such as PPK2.

## Client/server unions

Conceptually, version 7 extends the existing unions with:

```ts
type ClientMessage =
  | /* existing messages */
  | AcquisitionOperationStartMessage
  | AcquisitionOperationStopMessage
  | AcquisitionOperationGetMessage
  | AcquisitionOperationListMessage;

type ServerJsonMessage =
  | /* existing messages */
  | AcquisitionOperationResultMessage
  | AcquisitionOperationListResultMessage;
```

## JSON validation

Reject at least:

- application traffic before handshake;
- protocol-version mismatch;
- unknown message type;
- unsupported instrument identity;
- invalid/missing request IDs;
- invalid acquisition operation IDs;
- empty or overlong acquisition labels;
- malformed/non-finite control values;
- invalid viewport/measurement/control payloads.

Malformed data must not become partially populated domain objects.

## Backpressure and loss

JSON lifecycle/control/error traffic takes priority over stale DHO804 live display frames. Scope live frames may be replaced while a browser is backpressured.

Server-owned raw acquisitions use a different contract: source sequence/loss must remain detectable, and raw data must not be silently discarded merely to keep a graph current.

## Non-goals

Do not add without a concrete requirement:

- generic RPC/GraphQL;
- REST control endpoints;
- arbitrary instrument discovery;
- generic plugin protocols;
- universal sample payloads;
- browser subscription as a physical-runtime or acquisition-operation lease.
