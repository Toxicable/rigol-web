# Server Architecture

## Purpose

The Rigol Web server coordinates three fixed physical instrument runtimes, browser clients, and server-owned long-running acquisition operations. It remains deliberately concrete.

## Top-level structure

```text
Browser WebSocket
      |
      v
WebSocketGateway
(session/protocol broker)
  |-- AcquisitionWebSocketAdapter -> AcquisitionService
  |-- ScopeWebSocketAdapter       -> ScopeService -> ScopeRuntime -> DHO804 / SCPI
  |-- DmmWebSocketAdapter         -> DmmService   -> DmmRuntime   -> DM858E / SCPI
  `-- Ppk2WebSocketAdapter        -> Ppk2Service  -> Ppk2Runtime  -> PPK2Bridge / TBP2 TCP
                                         |
                                         `-> bounded acquisition store
```

`AcquisitionService` is intentionally outside `InstrumentRegistry`. Operation lifetime is not browser publication lifetime or physical runtime lifetime.

## Server-owned physical runtime lifetime

`InstrumentRegistry` owns process-lifetime start/stop for exactly three configured runtimes:

- DHO804 scope runtime;
- DM858E DMM runtime;
- PPK2 bridge runtime.

All start at server startup and remain active across browser navigation, last unsubscribe, browser disconnect and browser reconnect. Server shutdown stops all three.

`ScopeRuntime`, `DmmRuntime`, and `Ppk2Runtime` retain their own physical reconnect/recovery behavior while running.

## Server-owned acquisition lifetime

`AcquisitionService` owns long-running acquisition metadata/lifecycle:

- positive operation ID;
- label and initiator metadata;
- start/stop/failure timestamps/state;
- monotonic received-item/source-loss progress;
- bounded retention of terminal operation metadata.

A browser-started operation is not session-owned merely because its initiator records a browser session ID. Closing the browser socket does not stop it.

The service does not define a universal sample representation.

## Bounded acquisition storage

`BoundedAcquisitionChunkStore<T>` is the reusable retention primitive for loss-sensitive streaming producers.

The constructor requires an explicit byte capacity. Each append declares first sequence, item count, byte length and source-specific payload. The store:

- rejects backward/overlapping sequence ranges;
- records producer/source sequence gaps;
- evicts oldest complete chunks to enforce the byte cap;
- records retention eviction separately from source loss;
- supports sequence-range reads;
- exposes an export boundary.

PPK2 chooses a concrete 64 MiB payload budget. Its retained payload is `Float32` calibrated current plus `Uint32` original sample word, 8 bytes/sample. At 100 kSa/s the nominal payload-retention window is about 83.9 seconds before object/chunk overhead.

## WebSocket session/protocol broker

`WebSocketGateway` owns common browser transport/session behavior:

- `/ws` accept/close;
- protocol hello/version handshake;
- browser session identity;
- instrument publication subscriptions;
- JSON/binary sends;
- request completion/failure framing;
- socket buffered-byte/backpressure state;
- release of instrument adapter publication state on unsubscribe/close.

It does not own instrument application semantics.

After handshake, application-level acquisition requests are offered first to `AcquisitionWebSocketAdapter`, then requests are offered to the three fixed instrument adapters.

## AcquisitionWebSocketAdapter

Maps generic acquisition-operation start/stop/get/list messages to `AcquisitionService`.

Browser initiator session ID is metadata only. This adapter deliberately has no disconnect cleanup that stops an operation.

## ScopeWebSocketAdapter

Owns DHO804 browser-wire mapping:

- lifecycle/state;
- controls/interactions;
- Run/Stop/Single/Sleep;
- measurements/raw SCPI;
- deep capture/viewport;
- binary waveform delivery/backpressure;
- browser-session ownership of long-lived scope interaction.

DHO804 live waveform data remains disposable display data.

## DmmWebSocketAdapter

Owns DM858E lifecycle/state/snapshot publications, controls, raw SCPI, and retained latest-display snapshot replay.

DM858E latest snapshots are not unique physical samples and are not a logging stream.

## Ppk2WebSocketAdapter

Owns PPK2 browser-wire mapping:

- connected/disconnected lifecycle;
- capture statistics;
- decimated live display buckets;
- PPK2 capture start/stop;
- retained-history viewport reads.

Capture start/stop/viewport requests require a PPK2 publication subscription. Capture lifetime itself does not depend on that subscription.

Live PPK2 display updates are presentation-only summaries. The adapter checks per-browser WebSocket backpressure and may omit a decimated live update for a slow browser. It does not drop or renumber raw source samples; raw acquisition continues entirely in `Ppk2Service`.

## PPK2 physical/runtime path

```text
PPK2Bridge TCP
 -> Ppk2Runtime
 -> TBP2 frame parser
 -> metadata/calibration setup
 -> Ppk2StreamDecoder
 -> Ppk2Service
```

`Ppk2Runtime` owns TCP connection/reconnect, source-session identity, metadata retrieval, Ampere Meter configuration and measurement start/stop commands.

The TBP2 header carries a monotonic source byte offset. `Ppk2StreamDecoder` combines that with the PPK2 native 6-bit wrapping sample counter. Bridge gaps are counted exactly only when both boundaries remain aligned to the measurement's four-byte sample grid. Uncertain alignment fails the acquisition.

PPK2 does not use `ScpiTransport` or `ScpiScheduler`.

## PPK2 service path

`Ppk2Service` owns:

- one active capture at a time;
- shared `AcquisitionService` operation creation/stop/failure;
- calibrated current processing;
- source-loss progress updates;
- 64 MiB bounded raw retention;
- min/max/mean/RMS statistics;
- charge integration;
- live bucket aggregation;
- retained viewport reduction.

Current raw storage chunks contain 1,024 samples. Live display buckets aggregate 100 samples (1 ms), and 20 live buckets are normally emitted per service publication (~20 ms).

## Shared SCPI infrastructure

DHO804 and DM858E each have their own `ScpiScheduler` and `ScpiTransport` instance. They do not share a queue.

PPK2 is outside this infrastructure.

## Protocol compatibility

WebSocket protocol version **10** uses the application-level hello:

```text
server: ProtocolHello(10)
client: ProtocolHelloAck(10)
```

Version 10 is a hard cut adding PPK2 instrument/lifecycle/stats/live/capture/viewport messages. Existing numeric values remain stable; no compatibility shim is provided.

Instrument subscribe/unsubscribe remains publication state only and does not affect physical runtime or acquisition-operation lifetime.

## Failure philosophy

Prefer deterministic visible failure over hidden fallback.

For uncertain SCPI framing/socket integrity, fail affected work, close the uncertain session and recover through the server-owned runtime without replaying stale commands.

For PPK2, malformed framing, metadata loss, source-session change, replayed/backward offsets or uncertain sample alignment fail the current physical session/capture rather than guessing.

Raw loss is reported. Retention eviction is reported separately by the bounded store. Decimated live-display omission under browser backpressure is not raw acquisition loss.

## Dependency direction

```text
server composition
  |-- InstrumentRegistry -> ScopeRuntime / DmmRuntime / Ppk2Runtime
  |-- AcquisitionService
  `-- WebSocketGateway
        |-- AcquisitionWebSocketAdapter -> AcquisitionService
        |-- ScopeWebSocketAdapter -> ScopeService
        |-- DmmWebSocketAdapter -> DmmService
        `-- Ppk2WebSocketAdapter -> Ppk2Service -> AcquisitionService
```

Ordinary constructors and explicit callbacks are sufficient. Do not add a generic event bus, DI framework or plugin manager.

## Source layout

```text
src/
|- shared/
|  |- acquisition-types.ts
|  |- instrument-types.ts
|  |- ppk2-types.ts
|  |- scope-types.ts
|  |- dmm-types.ts
|  |- websocket-protocol.ts
|  `- waveform-protocol.ts
|
|- server/
|  |- server.ts
|  |- acquisition/
|  |- instruments/
|  |- scope/
|  |- dmm/
|  |- ppk2/
|  |- scpi/
|  |- waveform/
|  `- websocket/
|     |- websocket-gateway.ts
|     |- acquisition-websocket-adapter.ts
|     |- scope-websocket-adapter.ts
|     |- dmm-websocket-adapter.ts
|     `- ppk2-websocket-adapter.ts
|
`- web/
```

Tests live beside the files they exercise.
