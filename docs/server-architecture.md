# Server Architecture

## Purpose

The Rigol Web server coordinates two fixed SCPI instruments, browser clients, and server-owned long-running acquisition operations. It is deliberately concrete; shared infrastructure is kept only where there is real overlap.

## Top-level structure

```text
Browser WebSocket
      |
      v
WebSocketGateway
(session/protocol broker)
   /                 |                  \
  v                  v                   v
Acquisition          Scope               DMM
WebSocketAdapter     WebSocketAdapter    WebSocketAdapter
  |                  |                   |
  v                  v                   v
AcquisitionService   ScopeService        DmmService
                     |                   |
                     v                   v
                     ScopeRuntime        DmmRuntime
                       \                 /
                        InstrumentRegistry
```

The acquisition application service is intentionally outside `InstrumentRegistry`. Operation lifetime is not a physical-instrument runtime lifetime or browser publication subscription.

## Server-owned physical runtime lifetime

`InstrumentRegistry` owns only process-lifetime start/stop for the exactly two configured physical runtimes:

- DHO804 scope runtime;
- DM858E DMM runtime.

Both start at server startup and remain active across browser navigation, last unsubscribe, browser disconnect and browser reconnect. Server shutdown stops both.

`ScopeRuntime` and `DmmRuntime` retain their own physical reconnect/recovery behaviour while running.

## Server-owned acquisition lifetime

`AcquisitionService` owns long-running acquisition/recording metadata and lifecycle:

- positive operation ID;
- label and initiator metadata;
- start/stop/failure timestamps and state;
- monotonic received-item/source-loss progress;
- bounded retention of terminal operation metadata.

A browser-started operation is not session-owned merely because its initiator records a browser session ID. Closing that browser socket does not stop the operation. Explicit stop, explicit failure or server shutdown ends it.

The service does not define a universal sample representation. Concrete producers own their payload/sample semantics.

## Bounded acquisition storage

`BoundedAcquisitionChunkStore<T>` is the reusable retention primitive for loss-sensitive streaming producers.

The constructor requires an explicit byte capacity. Each appended source-specific chunk declares first sequence, item count and byte length. The store:

- rejects backward/overlapping sequence ranges;
- records producer/source sequence gaps as `sourceLostItems`;
- evicts oldest complete chunks to enforce the byte cap;
- records retention eviction separately from producer loss;
- supports sequence-range reads;
- exposes stored chunks through an export boundary.

No default PPK2 retention budget is chosen in Stream G. Stream H must pick a concrete byte budget from the desired retained duration and memory cost.

## WebSocket session/protocol broker

`WebSocketGateway` owns common browser transport/session behaviour:

- `/ws` accept/close;
- protocol hello/version handshake;
- browser session identity;
- instrument publication subscriptions;
- common JSON/binary sends;
- common request completion/failure framing;
- socket buffered-byte/backpressure state;
- release of instrument adapter session/publication state on unsubscribe/close.

It does not own scope, DMM or acquisition application semantics.

After the handshake, app-level acquisition requests are offered first to `AcquisitionWebSocketAdapter`, then instrument-specific requests are routed through the two instrument adapters. Acquisition operations do not require an instrument subscription.

## AcquisitionWebSocketAdapter

The fixed application-level adapter maps protocol-version-7 acquisition requests to `AcquisitionService`:

- start;
- stop;
- get;
- list.

It validates request/operation IDs and labels, records a browser initiator session ID on start, and returns typed operation results.

It deliberately has no unsubscribe/disconnect cleanup hook because those events do not own acquisition lifetime.

## ScopeWebSocketAdapter

Owns DHO804 browser-wire mapping:

- scope lifecycle/state publications;
- controls and interactions;
- run/stop/single and Sleep;
- measurements and raw SCPI;
- deep capture/viewport requests;
- binary waveform delivery and scope-specific backpressure;
- browser-session ownership of long-lived scope interactions.

DHO live waveform data remains disposable/latest-oriented and is not automatically an acquisition recording.

## DmmWebSocketAdapter

Owns DM858E browser-wire mapping:

- DMM lifecycle/state/current-snapshot publications;
- DMM controls;
- DM858E raw SCPI;
- replay of the retained display snapshot to a new subscriber.

DM858E latest snapshots do not have unique physical sample identity and are not a logging stream.

## Shared SCPI infrastructure

Each physical instrument has its own `ScpiScheduler` and `ScpiTransport` instance.

`ScpiTransport` owns one TCP socket and text/binary framing. `ScpiScheduler` owns serialized physical access, priorities, transaction ownership, supersession/coalescing where explicitly requested, and failure of pending work when the transport becomes unusable.

DHO804 and DM858E do not share a scheduler queue.

## DHO804 path

```text
WebSocketGateway
 -> ScopeWebSocketAdapter
 -> ScopeService
 -> ScopeController / waveform services
 -> ScopeRuntime
 -> Dho804Driver
 -> ScpiScheduler
 -> ScpiTransport
```

`ScopeService` is the server application boundary for scope controls, acquisition actions, measurements, raw SCPI, waveform/deep-capture operations and Sleep.

## DM858E path

```text
WebSocketGateway
 -> DmmWebSocketAdapter
 -> DmmService
 -> DmmRuntime
 -> Dm858eDriver
 -> ScpiScheduler
 -> ScpiTransport
```

`DmmService` owns mutation serialization, authoritative readback, stale function-dependent write rejection and current display-snapshot invalidation/deduplication.

## Protocol compatibility

WebSocket protocol version **7** uses the application-level hello:

```text
server: ProtocolHello(7)
client: ProtocolHelloAck(7)
```

Version 7 is a hard cut adding acquisition-operation start/stop/get/list request/result messages. No compatibility shim is provided.

Instrument subscribe/unsubscribe remains publication state only and does not affect physical runtime or acquisition-operation lifetime.

## Failure philosophy

Prefer deterministic visible failure over hidden fallback.

For uncertain SCPI socket/framing integrity, fail affected work, reject stale queued work, close the uncertain session and recover through the already-running physical runtime without replaying stale commands.

Loss-sensitive streaming producers must preserve/report sequence loss rather than silently using DHO live-waveform latest-frame replacement semantics.

## Dependency direction

```text
server composition
  |-- InstrumentRegistry -> ScopeRuntime / DmmRuntime
  |-- AcquisitionService
  `-- WebSocketGateway
        |-- AcquisitionWebSocketAdapter -> AcquisitionService
        |-- ScopeWebSocketAdapter -> ScopeService
        `-- DmmWebSocketAdapter -> DmmService
```

Ordinary constructors and explicit callbacks are sufficient. Do not add a generic event bus, DI framework or plugin manager.

## Source layout

```text
src/
|- shared/
|  |- acquisition-types.ts
|  |- instrument-types.ts
|  |- scope-types.ts
|  |- dmm-types.ts
|  |- websocket-protocol.ts
|  `- waveform-protocol.ts
|
|- server/
|  |- server.ts
|  |- acquisition/
|  |  |- acquisition-service.ts
|  |  `- bounded-chunk-store.ts
|  |- instruments/
|  |- scope/
|  |- dmm/
|  |- scpi/
|  |- waveform/
|  `- websocket/
|     |- websocket-gateway.ts
|     |- websocket-adapter.ts
|     |- acquisition-websocket-adapter.ts
|     |- scope-websocket-adapter.ts
|     `- dmm-websocket-adapter.ts
|
`- web/
```

Tests live beside the files they exercise.
