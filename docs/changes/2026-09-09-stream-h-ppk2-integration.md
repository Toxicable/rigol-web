# 2026-09-09 — Stream H PPK2 integration

## Result

Implemented PPK2 as the first non-SCPI loss-sensitive streaming instrument on the architecture established by Streams A-G.

Branch: `stream-h-ppk2-integration`.

## Server

- Added explicit shared PPK2 domain types and `SupportedInstrument.Ppk2 = 3`.
- Added `Ppk2Runtime` with server-owned TCP/reconnect/session lifetime.
- Added TBP2 version-1 bridge framing with source-session ID and monotonic byte-offset continuity.
- Added strict PPK2 metadata/calibration parsing and Nordic-compatible packed-sample current conversion/filtering.
- Added `Ppk2StreamDecoder` with bridge byte-loss accounting plus native 6-bit sample-counter loss detection.
- Uncertain four-byte sample alignment fails capture rather than silently resynchronizing.
- Added `Ppk2Service` backed by shared `AcquisitionService` operations.
- Added fixed 64 MiB bounded PPK2 payload retention using calibrated `Float32` current plus original `Uint32` sample word.
- Added server-side min/max/mean/RMS current, loss counts and charge integration.
- Added 1 ms live display buckets and retained viewport reduction.
- Added `Ppk2WebSocketAdapter` and required third instrument adapter in `WebSocketGateway`.
- Slow browsers may drop already-decimated PPK2 live display updates under WebSocket backpressure; raw acquisition continues server-side.
- Added PPK2 to the fixed `InstrumentRegistry` runtime set.

## Browser

- Added `/ppk2` route and navigation entry.
- Added `Ppk2Binding`, `Ppk2Actions`, and dedicated PPK2 Zustand store.
- Raw PPK2 sample arrays never enter React/Zustand.
- Browser live history is capped at 5,000 decimated buckets (~5 seconds with the current 1 ms bucket width).
- Added Start Capture, Stop Capture and Load retained history actions.
- Added decimated current trace plus current/charge/loss/retention statistics.
- PPK2 capture continues when the route unmounts or the browser disconnects; remount/reconnect receives current server state.

## Protocol

Hard-bumped WebSocket protocol from version 9 to **10**.

Added message types:

- 70 `Ppk2Connected`
- 71 `Ppk2Disconnected`
- 72 `Ppk2Stats`
- 73 `Ppk2Live`
- 74 `Ppk2CaptureStart`
- 75 `Ppk2CaptureStop`
- 76 `Ppk2ViewportRequest`
- 77 `Ppk2ViewportResult`

Existing numeric protocol values remain unchanged.

## PPK2Bridge contract

A concrete integration blocker was found in the original transparent-TCP idea: the PPK2 native sample counter is only six bits, so it cannot uniquely account arbitrary bridge-buffer overflow or long TCP interruption.

The Toxicboards PPK2Bridge contract was therefore updated to wrap PPK2->RigolWeb CDC bytes in TBP2 framing while keeping the CDC payload bytes unchanged. The header supplies source-session identity and monotonic byte offset. The fixed bridge listener is TCP port **5557**.

The relevant Toxicboards source is:

- <https://github.com/Toxicable/toxic-boards/blob/main/boards/PPK2Bridge/NETWORK_PROTOCOL.md>

This is a firmware/protocol change only; no PCB/BOM change is required.

## Retention numbers

PPK2 retained typed-array payload is 8 bytes/sample:

```text
4 bytes Float32 calibrated current
+ 4 bytes Uint32 original sample
= 8 bytes/sample
```

At 100,000 samples/s:

```text
800,000 bytes/s
64 MiB / 800,000 bytes/s ~= 83.9 s
```

This is nominal payload duration before JS object/chunk overhead.

## Tests added/updated

Source-level tests cover:

- TBP2 fragmentation and malformed frames;
- metadata/calibration/command encoding;
- split samples;
- exact aligned bridge loss;
- uncertain alignment failure;
- native counter loss;
- service operation/stat/charge/viewport behavior;
- capture failure on PPK2 physical disconnect;
- PPK2 WebSocket start/viewport mapping;
- unsubscribe-not-stop semantics;
- display-only live backpressure dropping;
- PPK2 binding/actions and request ownership;
- protocol v10 constants;
- fixed PPK2 runtime ownership in `InstrumentRegistry`.

During final strict-source audit, two compile-level issues were corrected: one unused service constant and one excess test sample field.

## Deployment

Server configuration now requires:

```text
PPK2_BRIDGE_HOST
PPK2_BRIDGE_PORT
```

`.env.example` and `docker-compose.yml` include the PPK2 endpoint. The selected port is 5557.

## Validation

Executable validation is still pending in this environment. The local runtime cannot resolve `github.com`, so a checkout cannot be obtained and `pnpm typecheck`, `pnpm test`, and `pnpm build` have not been run here.

No GitHub Actions result is claimed.

## Cost

Incremental hardware/BOM/paid-software cost: **A$0**.
