# Stream G — server-owned acquisition operations

Implemented 2026-09-09.

## Result

RigolWeb now has an explicit server-owned acquisition/recording operation model whose lifetime is independent of browser routes and WebSocket publication subscriptions.

- Added shared acquisition operation/initiator/progress/state types.
- Added `AcquisitionService` for start/stop/fail/get/list, monotonic progress, subscriber publication and bounded retention of terminal operation metadata.
- Added `BoundedAcquisitionChunkStore<T>` with explicit byte capacity, sequence-range reads, producer-loss accounting, retention-eviction accounting and export boundary.
- Added fixed application-level `AcquisitionWebSocketAdapter` rather than making the instrument adapter contract generic.
- `WebSocketGateway` now requires that application adapter and dispatches acquisition requests independently of instrument subscriptions.
- Server composition owns one `AcquisitionService` and closes it during shutdown.
- `AppConnection` can correlate acquisition-operation results; no PPK2/browser acquisition UI is added in this stream.

## Protocol

`PROTOCOL_VERSION` is now **7**.

New message values:

- 60 `AcquisitionOperationStart`
- 61 `AcquisitionOperationStop`
- 62 `AcquisitionOperationGet`
- 63 `AcquisitionOperationList`
- 64 `AcquisitionOperationResult`
- 65 `AcquisitionOperationListResult`

This is a hard cut with no compatibility alias or fallback.

## Lifetime semantics

Browser initiator metadata records which WebSocket session requested an operation, but does not create a session lease. A browser disconnect does not stop the operation. Explicit stop/failure or server shutdown ends it.

A socket integration test starts an operation from one browser, disconnects that browser, verifies the operation is still running, reconnects from another browser, lists the same operation and stops it explicitly.

## Loss/storage semantics

Operation progress exposes monotonic received-item, source-loss and last-sequence state. Once a concrete last sequence is known it may neither move backwards nor become unknown again.

`BoundedAcquisitionChunkStore<T>` keeps source payloads concrete rather than inventing a universal sample type. Source sequence gaps are counted as producer loss; byte-cap eviction is tracked separately and does not masquerade as source loss.

DHO804 live waveform latest-frame replacement remains unchanged and disposable. DHO804 deep capture remains concrete. DM858E latest display snapshots remain non-logging presentation snapshots.

## PPK2 contract

The implementation was checked against Toxicboards `projects/PPK2Wireless/PROJECT.yaml` and `docs/lab-gear/ppk2-connection.md` before finalizing the storage/loss contract. The planned bridge stream is approximately 100,000 four-byte samples/s, around 400 kB/s before overhead, with detectable loss required.

Stream G deliberately does not guess a retention duration or RAM budget. Stream H must choose the PPK2 store byte capacity from the desired retention window and memory cost, then add the PPK2-specific runtime/decoder/calibration/statistics/browser path.

## Tests added/updated

Source-level tests cover:

- bounded byte retention and eviction accounting;
- producer sequence gaps separately from retention eviction;
- sequence-range reads;
- invalid/overlapping/oversized chunks;
- operation lifecycle and terminal metadata bounds;
- monotonic progress including the last-sequence regression guard;
- operation lifetime after subscribers disappear;
- server shutdown stopping running operations;
- protocol-v7 constants;
- required application-adapter composition in existing WebSocket harnesses;
- browser-disconnect survival through a real WebSocket server.

## Validation status

The available environment cannot resolve GitHub through `git`, so there is no runnable checkout here. The repository also has no GitHub Actions workflow available as an execution substitute.

`pnpm typecheck`, `pnpm test` and `pnpm build` therefore remain **pending executable validation**. This change note records source/test audit only and does not claim those commands passed.

Incremental software/package/hardware cost: **A$0**.
