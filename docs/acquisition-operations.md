# Acquisition operations

## Purpose

Rigol Web has an explicit server-owned acquisition/recording operation model for long-running loss-sensitive streams. PPK2 is the first concrete producer using it.

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

A running operation can survive route unmount, instrument unsubscribe, browser close, and later browser reconnect.

## Progress and loss

Each operation exposes:

```ts
interface AcquisitionProgress {
  receivedItems: number;
  sourceLostItems: number;
  lastSequence: number | null;
}
```

Counts are absolute and monotonic. `lastSequence` cannot move backward or become unknown after it has been established.

`sourceLostItems` represents loss in the producer/source stream, not data intentionally evicted from bounded retention.

A concrete streaming producer normalizes its native sequence into monotonic sequence space before updating the service.

For PPK2, `Ppk2StreamDecoder` combines bridge byte offsets and the native wrapping 6-bit device counter. Bridge gaps that do not preserve the four-byte measurement sample boundary fail rather than being guessed around.

## Bounded source storage

`BoundedAcquisitionChunkStore<T>` is a source-agnostic retention utility. `T` remains the concrete producer payload; Rigol Web does not define a universal scope/DMM/PPK2 sample structure.

Each chunk carries:

- first sequence;
- item count;
- byte length;
- source-specific payload.

When appending would exceed the configured byte budget, oldest complete chunks are evicted until the store is within bounds. Retention eviction is tracked independently from source loss.

The store exposes bounded statistics, sequence-range reads, an `exportChunks()` boundary and explicit clear.

A chunk larger than the configured capacity is rejected rather than truncated.

## PPK2 concrete storage

PPK2 uses a fixed **64 MiB** payload capacity.

Each retained sample is 8 bytes of typed-array payload:

- `Float32` calibrated current;
- `Uint32` original packed sample word.

At 100 kSa/s that is 800,000 payload bytes/s, corresponding to about **83.9 seconds** of nominal retained payload before chunk/object overhead.

The current PPK2 storage chunk size is 1,024 samples.

PPK2 retention eviction does not increment the capture's source-loss count.

## PPK2 operation ownership

`Ppk2Service.startCapture()` creates the shared operation and starts physical PPK2 measurement. `stopCapture(operationId)` stops measurement and completes that operation.

Physical bridge/PPK2 failure while a capture is active marks the operation failed.

The PPK2 WebSocket adapter deliberately does nothing to the operation on route unsubscribe or browser socket close. The server runtime and operation continue.

When a browser returns to `/ppk2`, the current operation and stats are replayed through PPK2 publications.

## Generic WebSocket API

The application-level generic acquisition requests remain:

- `AcquisitionOperationStart` (60)
- `AcquisitionOperationStop` (61)
- `AcquisitionOperationGet` (62)
- `AcquisitionOperationList` (63)
- `AcquisitionOperationResult` (64)
- `AcquisitionOperationListResult` (65)

They do not require an instrument publication subscription.

PPK2-specific start/stop requests use message types 74/75 because they must coordinate the PPK2 physical measurement stream through `Ppk2Service`. Successful requests still return `AcquisitionOperationResult` so operation identity/state remains the common envelope.

## Existing instrument semantics remain unchanged

- DHO804 live waveform frames remain disposable/latest-oriented display data.
- DHO804 deep captures retain their concrete representation.
- DM858E latest snapshots remain display snapshots without unique physical sample identity.

PPK2 is the concrete loss-sensitive source that uses the acquisition store. Its raw acquisition never uses DHO804 latest-frame replacement semantics.

The only disposable PPK2 data is the already-decimated browser live-display publication. Dropping such a display summary under browser backpressure does not change server raw storage or source-loss accounting.

## Cost

Stream G/H acquisition infrastructure adds no paid service, package, or hardware requirement. Incremental cost: **A$0**.
