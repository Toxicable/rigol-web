# WebSocket Protocol

## Overview

Rigol Web uses one persistent WebSocket connection per browser tab. The protocol is application-specific, not generic RPC.

Current protocol version:

```ts
export const PROTOCOL_VERSION = 10;
```

Version 10 is a hard cut. It adds PPK2 as an explicit supported instrument plus PPK2 lifecycle, capture-stat, decimated-live, capture start/stop and retained-viewport messages. Browser and server bundles must agree exactly during the hello handshake; no compatibility shim is provided.

Existing numeric message/control values remain stable.

Supported instrument identities are:

```ts
export enum SupportedInstrument {
  Dho804 = 1,
  Dm858e = 2,
  Ppk2 = 3,
}
```

Use JSON for handshake, subscriptions, lifecycle/state, controls, operation metadata, PPK2 display summaries, results and errors. Browser binary frames remain DHO804 waveform payloads only. Raw PPK2 acquisition bytes never traverse the browser WebSocket.

## Application-level hello

Immediately after `/ws` connection:

```text
server -> ProtocolHello { protocolVersion: 10 }
browser -> ProtocolHelloAck { protocolVersion: 10 }
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

  Ppk2Connected = 70,
  Ppk2Disconnected = 71,
  Ppk2Stats = 72,
  Ppk2Live = 73,
  Ppk2CaptureStart = 74,
  Ppk2CaptureStop = 75,
  Ppk2ViewportRequest = 76,
  Ppk2ViewportResult = 77,
}
```

## Instrument subscriptions

After handshake, route bindings explicitly subscribe/unsubscribe to DHO804, DM858E or PPK2 publications.

Subscriptions control browser publication fanout only. They do not start/stop physical runtimes and do not own server acquisition lifetime.

Scope/DMM commands require the corresponding instrument subscription. PPK2 capture start/stop/viewport requests require a PPK2 subscription.

The generic acquisition-operation start/stop/get/list requests remain application-level and do not require an instrument subscription.

## Server-owned acquisition operations

The generic acquisition-operation API remains:

```ts
AcquisitionOperationStart // 60
AcquisitionOperationStop  // 61
AcquisitionOperationGet   // 62
AcquisitionOperationList  // 63
AcquisitionOperationResult // 64
AcquisitionOperationListResult // 65
```

Browser initiator session ID is metadata only. Closing that socket does not stop the operation.

PPK2 capture start/stop uses the same `AcquisitionOperation` result envelope but is routed through `Ppk2Service`, which also starts/stops the physical PPK2 measurement stream.

## PPK2 lifecycle

A subscribed browser receives one of:

```ts
interface Ppk2ConnectedMessage {
  type: MessageType.Ppk2Connected; // 70
  protocolVersion: number;
  info: Ppk2Info;
}

interface Ppk2DisconnectedMessage {
  type: MessageType.Ppk2Disconnected; // 71
  reason: string;
}
```

`Ppk2Info` includes the bridge/Ppk2 source-session ID, hardware/calibration metadata where available, VDD metadata, and the fixed 10 us sample interval.

PPK2 physical runtime lifetime is server-owned; route unsubscribe only stops publications to that browser.

## PPK2 statistics

`Ppk2Stats` (72) carries `Ppk2CaptureStats`:

- current `AcquisitionOperation` or null;
- received/lost sample counts;
- retained sample count/duration;
- latest sample sequence/current;
- min/max/mean/RMS current;
- integrated charge in microamp-hours.

Statistics are derived from the server-side raw acquisition stream, not from browser display buckets.

## PPK2 live display

`Ppk2Live` (73) carries:

```ts
interface Ppk2LiveUpdate {
  operationId: number;
  buckets: readonly Ppk2DisplayBucket[];
}
```

Each display bucket contains first/last source sequence, sample count, min/max/mean current, and logic OR/AND.

Current server reduction is 100 raw samples per bucket (1 ms at 100 kSa/s), normally 20 buckets per publication (~20 ms).

This is display data, not raw acquisition data. If a browser WebSocket is backpressured, the server may omit a PPK2 live display update for that browser. The raw acquisition continues server-side and loss accounting is unaffected.

Every live update carries `operationId` so a browser never attaches stale buckets to a newer capture.

## PPK2 capture commands

Start:

```ts
interface Ppk2CaptureStartMessage {
  type: MessageType.Ppk2CaptureStart; // 74
  requestId: number;
}
```

Success returns `AcquisitionOperationResult` with the new running PPK2 operation.

Stop:

```ts
interface Ppk2CaptureStopMessage {
  type: MessageType.Ppk2CaptureStop; // 75
  requestId: number;
  operationId: number;
}
```

Success returns `AcquisitionOperationResult` with the stopped operation.

Both require an active PPK2 publication subscription. Unsubscribing after start does not stop the capture.

## PPK2 retained viewport

Request:

```ts
interface Ppk2ViewportRequestMessage {
  type: MessageType.Ppk2ViewportRequest; // 76
  requestId: number;
  operationId: number;
  firstSequence: number;
  endSequenceExclusive: number;
  maxBuckets: number;
}
```

Result:

```ts
interface Ppk2ViewportResultMessage {
  type: MessageType.Ppk2ViewportResult; // 77
  requestId: number;
  viewport: Ppk2Viewport;
}
```

The server validates positive operation IDs, non-negative sequence bounds, increasing ranges and the PPK2 viewport bucket limit. The concrete service currently allows at most 2,000 viewport buckets.

Viewport data is reduced server-side from retained raw PPK2 chunks; raw arrays are not sent to the browser.

## Scope lifecycle and controls

DHO804 lifecycle/state/controls retain their existing values and semantics.

The physical DHO804 is authoritative. Browser controls may update presentation optimistically, with later authoritative state reconciliation.

DHO804 acquisition actions Run/Stop/Single remain instrument actions and are unrelated to server-owned acquisition-operation lifetime.

## DMM lifecycle and controls

DM858E lifecycle/state/snapshot/control messages retain their existing values and semantics.

`DmmSnapshot` is current display state, not a uniquely identified physical sample event and must not be treated as a logging stream.

## Scope Sleep

`ScopeSleep` remains a typed request with request ID. Success returns `CommandCompleted`; failure returns `CommandFailed`.

## Measurements, raw SCPI and DHO deep capture

DHO804 measurements use typed request/result messages. Raw SCPI remains explicitly instrument-targeted to the SCPI instruments. PPK2 does not expose SCPI.

DHO804 deep-capture/viewport messages retain their concrete scope model.

## Request completion

Messages with request IDs receive a typed result, `CommandCompleted`, or `CommandFailed`. `AppConnection` owns app-wide request ID allocation/correlation.

## DHO804 binary waveforms

Binary waveform frames remain outside `ServerJsonMessage` and use `waveform-protocol.md`.

DHO804 live waveform frames are disposable/latest-oriented under backpressure. That behavior must not be reused for PPK2 raw acquisition. Only PPK2's already-decimated browser display summaries may be omitted under browser backpressure.

## JSON validation

Reject at least:

- application traffic before handshake;
- protocol-version mismatch;
- unknown message/control types;
- unsupported instrument identity;
- invalid/missing request IDs;
- invalid acquisition operation IDs;
- malformed/non-finite scope/DMM controls;
- invalid enum values;
- invalid scope/DMM viewport/measurement payloads;
- invalid PPK2 operation IDs;
- invalid PPK2 sequence ranges;
- invalid PPK2 viewport bucket counts.

Malformed data must not become partially populated domain objects.

## Non-goals

Do not add without a concrete requirement:

- generic RPC/GraphQL;
- REST control endpoints;
- arbitrary instrument discovery;
- generic plugin protocols;
- universal sample payloads;
- browser subscription as a physical-runtime or acquisition-operation lease.
