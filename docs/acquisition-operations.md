# Acquisition operations

## Purpose

RigolWeb has an explicit server-owned acquisition/recording operation model for long-running streams such as the upcoming PPK2 integration.

An acquisition operation is not a browser route, WebSocket subscription, or physical-instrument runtime lease. Its lifetime belongs to the server application and ends only by explicit stop, failure, or server shutdown.

## Lifecycle

`AcquisitionService` owns operation metadata and lifecycle:

- positive operation ID;
- label;
- initiator metadata;
- start timestamp;
- `Running`, `Stopped`, or `Failed` state;
- explicit stop/failure;
- monotonic progress;
- bounded retention of terminal operation metadata.

Browser initiator metadata records the WebSocket session that requested the operation, but it is informational. Closing that session does not stop the operation.

A running operation can therefore survive route unmount, instrument unsubscribe, browser close, and a later browser reconnect. Server shutdown calls `AcquisitionService.close()`, which stops remaining running operations.

## Progress and loss

Each operation exposes:

```ts
interface AcquisitionProgress {
  receivedItems: number;
  sourceLostItems: number;
  lastSequence: number | null;
}
```

Counts are absolute and monotonic. `sourceLostItems` represents loss in the producer/source stream, not data intentionally evicted from bounded retention.

A concrete streaming producer must normalize its native sequence representation into a monotonic sequence before updating the service. For PPK2, handling the device's wrapping sample counter belongs in the PPK2 decoder/runtime, not in the generic acquisition service.

## Bounded source storage

`BoundedAcquisitionChunkStore<T>` is a source-agnostic retention utility. `T` is deliberately the concrete producer payload; RigolWeb does not define a universal scope/DMM/PPK2 sample structure.

Each stored chunk carries:

- first sequence;
- item count;
- byte length;
- source-specific payload.

Capacity is an explicit byte limit supplied by the concrete source. Stream G intentionally does not guess a PPK2 retention duration or memory budget.

When a new chunk exceeds the configured retained-byte budget, the oldest complete chunks are evicted until the store is within bounds. Retention eviction is tracked independently from producer/source loss.

The store exposes:

- bounded storage statistics;
- sequence-range reads returning intersecting chunks;
- an `exportChunks()` boundary for source-specific export code;
- explicit clear.

A single chunk larger than the configured capacity is rejected rather than silently truncating source data.

## WebSocket API

Protocol version 7 adds application-level acquisition requests that do not require an instrument publication subscription:

- `AcquisitionOperationStart` (60)
- `AcquisitionOperationStop` (61)
- `AcquisitionOperationGet` (62)
- `AcquisitionOperationList` (63)
- `AcquisitionOperationResult` (64)
- `AcquisitionOperationListResult` (65)

`AcquisitionWebSocketAdapter` is an application-level adapter attached directly to `WebSocketGateway`. It is intentionally separate from `ScopeWebSocketAdapter` and `DmmWebSocketAdapter` because operation lifetime is not an instrument publication concern.

## Existing instrument semantics remain unchanged

Stream G does not retrofit existing display paths into recordings:

- DHO804 live waveform frames remain disposable/latest-oriented display data.
- DHO804 deep captures remain their existing concrete retained representation.
- DM858E latest snapshots remain display snapshots without unique physical sample identity and are not logging data.

The acquisition model exists so loss-sensitive sources such as PPK2 can preserve sequence/loss semantics without degrading those existing paths.

## PPK2 handoff

The Toxicboards PPK2Wireless contract expects roughly 100,000 four-byte samples per second, about 400 kB/s before transport overhead. RigolWeb will own PPK2 decoding, calibration/metadata, sequence/loss accounting, statistics, charge integration, bounded retention, viewport/decimation and browser presentation.

Stream H must choose an explicit PPK2 retention byte budget based on the desired retained duration/memory cost and connect the PPK2 producer to this operation/storage boundary. No additional hardware or software package cost is introduced by Stream G: **A$0**.
