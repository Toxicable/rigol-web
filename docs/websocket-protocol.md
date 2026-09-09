# WebSocket Protocol

## Overview

Rigol Web uses one persistent WebSocket connection per browser tab. The protocol is application-specific, not generic RPC.

Current protocol version:

```ts
export const PROTOCOL_VERSION = 8;
```

Version 8 is a hard cut. It adds typed DHO804 configuration controls for state that RigolWeb already reads authoritatively: channel coupling/probe ratio, horizontal mode, trigger sweep/coupling, and acquisition type/averages/memory depth. Browser and server bundles must agree exactly during the hello handshake; no compatibility shim is provided.

Version 7 added the server-owned acquisition-operation lifecycle requests/results. Those message values and semantics remain unchanged in version 8.

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
server -> ProtocolHello { protocolVersion: 8 }
browser -> ProtocolHelloAck { protocolVersion: 8 }
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

Protocol version 7 added:

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

Success returns either `AcquisitionOperationResult` (64) or `AcquisitionOperationListResult` (65). A browser initiator records the requesting server-side WebSocket session ID as metadata only; closing that socket does not stop the operation.

## Scope lifecycle

DHO804 lifecycle messages remain distinct. `ScopeConnected` is not published until identity is verified and complete authoritative `ScopeState` is available.

The physical DHO804 is authoritative. Browser controls may update presentation optimistically, but the server reconciles controls whose physical result can affect related state.

## DHO804 controls and interactions

Scope controls use the typed `ControlChange` union. Version 8 extends `ControlKind` without renumbering the original values:

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
  ChannelCoupling = 10,
  ChannelProbeRatio = 11,
  HorizontalMode = 12,
  TriggerSweep = 13,
  TriggerCoupling = 14,
  AcquisitionType = 15,
  AcquisitionAverages = 16,
  AcquisitionMemoryDepth = 17,
}
```

Discrete controls use `ControlSet`. Continuous interaction updates remain limited to channel scale/offset, horizontal scale/position and trigger level; disposable updates carry no request ID and the final `InteractionCommit` carries a request ID.

The DHO804 mapping used by the server is:

| Control | SCPI write | Reconciliation |
| --- | --- | --- |
| Channel coupling | `:CHANnel<n>:COUPling AC|DC|GND` | channel state readback |
| Probe selector | `:CHANnel<n>:PROBe 1|10` | channel state readback |
| Horizontal mode | `:TIMebase:MODE MAIN|ROLL|XY` | horizontal state readback |
| Trigger sweep | `:TRIGger:SWEep AUTO|NORMal|SINGle` | trigger + run-state readback |
| Trigger coupling | `:TRIGger:COUPling AC|DC|LFReject|HFReject` | trigger state readback |
| Acquisition type | `:ACQuire:TYPE NORMal|PEAK|AVERages|ULTRa` | acquisition state readback |
| Acquisition averages | `:ACQuire:AVERages <2..65536 power-of-two>` | acquisition state readback |
| Acquisition memory | `:ACQuire:MDEPth <depth>` | acquisition state readback |

The browser intentionally exposes only **1× and 10×** probe selections even though the DHO804 supports additional probe ratios. If the instrument is already configured to another ratio, the UI can display that current value and offers 1×/10× as the writable choices requested for RigolWeb.

DHO804 memory-depth writes are restricted to numeric depths supported by the DHO804 and by the current number of enabled channels: up to 25 Mpts with one channel, 10 Mpts with two, and 5 Mpts with three or four. `AUTO` is not exposed because `ScopeState.memoryDepth` is an authoritative numeric depth rather than an Auto/fixed discriminated state.

DHO804 acquisition actions remain Run (1), Stop (2) and Single (3). They are instrument actions and are unrelated to the server-owned acquisition-operation lifecycle.

## DMM lifecycle and snapshots

DM858E lifecycle remains separate from scope lifecycle. `DmmSnapshot` is current display state, not a uniquely identified physical sample event, and must not be used as a logging/statistics stream.

## Scope Sleep

`ScopeSleep` remains a typed request with request ID. Success returns `CommandCompleted`; failure returns `CommandFailed`.

## DMM controls

DMM controls use `DmmControlSet` and the typed `DmmControlChange` union. Function-dependent range/rate controls carry the function under which they were created so stale writes can be rejected rather than reinterpreted.

## Measurements, raw SCPI and deep capture

DHO804 measurements use typed request/result messages. Raw SCPI remains explicitly instrument-targeted. Deep-capture and viewport messages retain the existing DHO804-specific retained-capture model.

## Request completion

Messages with request IDs receive a typed result, `CommandCompleted`, or `CommandFailed`. `AppConnection` owns request ID allocation/correlation.

## DHO804 binary waveforms

Binary waveform frames remain outside `ServerJsonMessage` and use `waveform-protocol.md`. Live waveform frames are disposable/latest-oriented under backpressure; that behavior must not be reused for loss-sensitive raw acquisition streams such as PPK2.

## JSON validation

Reject at least:

- application traffic before handshake;
- protocol-version mismatch;
- unknown message/control types;
- unsupported instrument identity;
- invalid/missing request IDs;
- invalid acquisition operation IDs;
- malformed/non-finite controls;
- invalid enum values;
- unsupported DHO804 probe ratio writes;
- invalid acquisition averaging/memory settings;
- invalid viewport/measurement payloads.

Malformed data must not become partially populated domain objects.

## Non-goals

Do not add without a concrete requirement:

- generic RPC/GraphQL;
- REST control endpoints;
- arbitrary instrument discovery;
- generic plugin protocols;
- universal sample payloads;
- browser subscription as a physical-runtime or acquisition-operation lease.
