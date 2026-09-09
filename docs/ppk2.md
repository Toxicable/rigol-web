# PPK2 integration

## Purpose

Rigol Web integrates the Nordic Power Profiler Kit II as a concrete non-SCPI, loss-sensitive streaming instrument. The PPK2 path does not use `ScpiScheduler` and does not reuse the DHO804 disposable raw-waveform semantics.

**Stream H currently implements Ampere Meter mode.** DUT power remains external to PPK2Bridge; the bridge powers/hosts the PPK2 and transports its CDC protocol to Rigol Web.

The canonical Toxicboards PPK2Wireless project has since expanded to require both Ampere Meter and Source Meter modes. Source Meter control/presentation is therefore a follow-up PPK2Wireless requirement; it is not implemented or claimed complete by Stream H. The runtime deliberately configures Ampere Meter mode today.

Hardware/software contract sources:

- Toxicboards PPK2Wireless project: <https://github.com/Toxicable/toxic-boards/blob/main/projects/PPK2Wireless/PROJECT.yaml>
- PPK2Bridge network protocol: <https://github.com/Toxicable/toxic-boards/blob/main/boards/PPK2Bridge/NETWORK_PROTOCOL.md>
- PPK2 connection/protocol notes: <https://github.com/Toxicable/toxic-boards/blob/main/docs/lab-gear/ppk2-connection.md>

Incremental Stream H hardware/BOM cost: **A$0**. The integration changes software and the existing bridge firmware contract only.

## End-to-end path

```text
PPK2 USB CDC
  -> ESP32-S3 PPK2Bridge
  -> TBP2 framed TCP stream
  -> Ppk2Runtime
  -> Ppk2StreamDecoder / Ppk2CurrentConverter
  -> Ppk2Service
       |-> AcquisitionService operation lifecycle
       |-> BoundedAcquisitionChunkStore<Ppk2StoredChunk>
       |-> current statistics + charge integration
       |-> decimated live/history buckets
  -> Ppk2WebSocketAdapter
  -> AppConnection
  -> Ppk2Binding
  -> Ppk2Actions / PPK2 UI
```

PPK2 raw samples never enter Zustand or the browser WebSocket stream.

## Required server configuration

```text
PPK2_BRIDGE_HOST=<bridge LAN address/hostname>
PPK2_BRIDGE_PORT=5557
```

Port `5557` is the fixed PPK2Bridge TBP2 listener selected in Toxicboards. Server startup requires the PPK2 endpoint just like the configured scope and DMM endpoints.

## Bridge transport and loss accounting

Rigol Web -> bridge TCP bytes are the unmodified PPK2 CDC command stream.

Bridge -> Rigol Web uses TBP2 version 1 frames. The 24-byte header carries:

- magic `TBP2`;
- frame version/type;
- `sourceSessionId` for one PPK2 USB enumeration;
- monotonic source `streamOffset`;
- payload length.

Data-frame payload bytes are unchanged PPK2 CDC bytes. The bridge advances `streamOffset` for every PPK2 byte received even if buffering/network handling later discards a byte. This lets Rigol Web distinguish actual source/transport loss from server retention eviction.

A source-session change while capturing fails the capture. Metadata-stream loss also fails the session because calibration metadata must not be guessed.

During measurement, a bridge gap is recoverable only when both sides preserve the four-byte measurement sample boundary. If the expected and resumed offsets are not aligned relative to the measurement base, the acquisition fails instead of silently resynchronizing.

The decoder also checks the PPK2 native wrapping 6-bit sample counter. With continuous bridge offsets, a native counter discontinuity contributes to source-loss accounting. After an already-accounted bridge gap the native counter baseline is reset so the same loss is not counted twice.

## PPK2 initialization

`Ppk2Runtime` owns the physical TCP/session loop. For each usable PPK2 USB source session it:

1. receives the bridge USB-connected status and source offset;
2. stops averaging and drains outstanding measurement bytes;
3. requests PPK2 metadata;
4. requires complete calibration coefficients;
5. normalizes unsafe persisted user gains to unity and writes those gains back;
6. configures Ampere Meter mode;
7. enables the PPK2 device;
8. creates the calibrated current converter;
9. publishes the connected PPK2 identity/metadata.

A malformed TBP2 frame, calibration failure, source-session change, socket failure, or uncertain measurement alignment tears down the physical session and lets the server-owned runtime reconnect.

## Acquisition lifecycle

PPK2 captures use the shared `AcquisitionService` operation envelope.

`Ppk2Service.startCapture()` creates a `PPK2 capture` acquisition operation and starts the PPK2 measurement stream. `stopCapture()` explicitly stops the measurement and marks the operation stopped. Physical PPK2 failure marks a running capture failed.

Browser navigation, unsubscribe, WebSocket close, or reconnect does **not** stop a PPK2 capture. A remounted `/ppk2` route receives current lifecycle/stat publications and can continue observing the same operation.

## Raw retention

`Ppk2Service` uses a fixed **64 MiB** `BoundedAcquisitionChunkStore<Ppk2StoredChunk>`.

Each retained sample stores:

- calibrated current as `Float32` — 4 bytes;
- original packed PPK2 sample word as `Uint32` — 4 bytes.

At 100,000 samples/s this is 800,000 retained payload bytes/s. Ignoring object/chunk overhead, 64 MiB therefore retains about:

```text
67,108,864 bytes / 8 bytes/sample / 100,000 samples/s ~= 83.9 s
```

The store evicts oldest complete chunks when the byte budget is exceeded. Retention eviction is separate from source loss and does not increment acquisition `sourceLostItems`.

The current chunk size is 1,024 samples.

## Statistics and charge

Statistics are derived server-side from every accepted calibrated sample:

- latest current;
- minimum/maximum;
- arithmetic mean;
- RMS current;
- received/lost sample counts;
- retained sample count/duration;
- accumulated charge in microamp-hours.

Charge integration uses the fixed 10 us sample interval:

```text
charge_uAh += current_uA * 10 us / 3,600,000,000
```

Loss is reported separately rather than silently filling or interpolating missing samples.

## Display decimation

Raw samples are not published to browsers by default.

Live display reduction is concrete and bounded:

- 100 raw samples per display bucket = 1 ms at 100 kSa/s;
- each bucket carries first/last sequence, sample count, min/max/mean current and logic OR/AND;
- 20 buckets are normally published together = about one JSON live update every 20 ms;
- slow/backpressured browser sessions may drop these **decimated display updates only**; the server raw acquisition continues without dropping data for display freshness;
- the browser retains at most 5,000 live buckets, about five seconds at the current bucket width.

The browser can explicitly request retained history. `Ppk2Service.readViewport()` reduces a sequence range to at most 2,000 buckets; the current PPK2 action requests 1,200 buckets for the full retained operation range.

## Browser ownership

`AppConnection` remains generic transport/request correlation.

`Ppk2Binding` owns:

- PPK2 subscribe/unsubscribe publication mapping;
- connected/disconnected projection;
- stats/live projection;
- capture and viewport wire requests.

`Ppk2Actions` owns:

- duplicate/pending request suppression;
- start/stop/history intent;
- pending/error presentation.

`ppk2-store.ts` contains only display/domain summaries and decimated buckets. It never stores raw acquisition arrays.

## WebSocket protocol

PPK2 browser support is a hard protocol-version **10** cut.

Message types 70-77 are PPK2-specific:

- `Ppk2Connected` (70)
- `Ppk2Disconnected` (71)
- `Ppk2Stats` (72)
- `Ppk2Live` (73)
- `Ppk2CaptureStart` (74)
- `Ppk2CaptureStop` (75)
- `Ppk2ViewportRequest` (76)
- `Ppk2ViewportResult` (77)

PPK2 capture start/stop/viewport requests require a PPK2 publication subscription. Successful capture start/stop returns the shared `AcquisitionOperationResult` so operation identity/lifecycle remains the common server-owned envelope.

Raw SCPI is restricted to the explicit `ScpiInstrument` union (`Dho804 | Dm858e`). PPK2 is rejected as a SCPI target at both the typed browser API and server validation boundary.

## Tests

Focused source tests cover:

- fragmented/malformed TBP2 framing;
- metadata/command/calibration behavior;
- split four-byte samples;
- aligned bridge loss and uncertain-alignment failure;
- native sample-counter loss;
- PPK2 capture statistics, charge, retained viewport, and failure lifecycle;
- WebSocket start/viewport mapping and unsubscribe-not-stop semantics;
- browser binding/actions and pending/error ownership;
- explicit rejection of PPK2 as a SCPI target;
- server-owned PPK2 runtime lifetime alongside DHO804/DM858E.

Executable `pnpm typecheck`, `pnpm test`, and `pnpm build` remain required before a fully validated release.
