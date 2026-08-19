# Waveform Implementation Workstream

## Audience

This handoff covers server-side live waveform streaming, deep capture ownership, downsampling and browser-frame encoding after foundation has landed.

It does not implement DHO804 SCPI parsing, WebSocket connection handling or the React/uPlot frontend.

It can be developed in parallel with the server-control and frontend workstreams once the shared contracts exist.

## Read first

Read:

- `docs/architecture.md`
- `docs/development-practices.md`
- `docs/typescript-practices.md`
- `docs/server-architecture.md`
- `docs/scpi-scheduler.md`
- `docs/scope-model.md`
- `docs/waveforms.md`
- `docs/waveform-protocol.md`
- `docs/websocket-protocol.md`
- `docs/testing.md`

Also read `docs/workstreams/scpi-backend.md` for the normalized waveform API this workstream consumes.

## File ownership

This workstream owns:

```text
src/server/waveform/
|- live-waveform-service.ts
|- live-waveform-service.test.ts
|- deep-capture-service.ts
|- deep-capture-service.test.ts
|- downsample.ts
|- downsample.test.ts
|- waveform-frame-encoder.ts
`- waveform-frame-encoder.test.ts
```

Small single-purpose files under `src/server/waveform/` are acceptable if genuinely useful.

Do not edit:

- `src/server/scpi/**`
- `src/server/scope/dho804-driver.ts`
- `src/server/scope/scope-controller.ts`
- `src/server/websocket/**`
- `src/server/server.ts`
- `src/server/scope-runtime.ts`
- `src/web/**`
- `src/shared/**`

Final wiring belongs to the integration workstream.

## Required DHO804 driver surface

Consume the typed normalized waveform methods from the SCPI backend:

```ts
interface Dho804Waveform {
  channel: Channel;
  unit: ChannelUnit;
  samples: Float32Array;
  xIncrement: number;
  xOrigin: number;
  xReference: number;
}

readLiveWaveform(
  channel: Channel,
  pointCount: number,
): Promise<Dho804Waveform>;

readRawWaveform(
  channel: Channel,
  sampleCount: number,
): Promise<Dho804Waveform>;

readScopeState(priority: ScpiPriority): Promise<ScopeState>;
```

This workstream must not know about Rigol TMC block headers, native WORD bytes, `YORigin`, `YREFerence` or SCPI command strings.

If the concrete driver API differs slightly after the backend lands, adapt calls locally rather than moving native parsing into the waveform layer.

## Shared binary protocol

Use the constants/enums in:

```text
src/shared/waveform-protocol.ts
src/shared/websocket-protocol.ts
```

Do not change header offsets or enum values.

Version 1 frame layout is fixed by `docs/waveform-protocol.md`:

- 64-byte little-endian header
- 8-byte indexed Float32 records
- source sample indices are zero-based
- source ranges are half-open
- live `captureId = 0`
- deep capture IDs are positive

## `waveform-frame-encoder.ts`

Implement one focused encoder for the exact shared binary format.

A useful input shape is:

```ts
interface WaveformFrameInput {
  kind: WaveformKind;
  channel: Channel;
  unit: ChannelUnit;
  sequence: number;
  captureId: number;
  sourceStartSample: number;
  sourceEndSample: number;
  xIncrement: number;
  xOrigin: number;
  xReference: number;
  sampleIndices: Uint32Array;
  values: Float32Array;
}
```

Every field is required.

Require:

- equal index/value lengths
- finite X metadata
- finite values
- every index within `[sourceStartSample, sourceEndSample)`
- valid live/deep capture ID rule

Allocate one output `ArrayBuffer`/`Uint8Array` of exactly:

```text
64 + pointCount * 8
```

Write the header and records using little-endian `DataView` operations.

Return `Uint8Array`.

Do not create a generic serializer library.

## Fixed-byte encoder test

Create at least one fixed known fixture whose expected bytes are written independently in the test.

Assert header offsets and payload bytes, not merely round-trip through your own encoder/decoder.

The frontend workstream will separately test its decoder against the same documented layout.

## `LiveWaveformService`

This service owns recurring NORMAL waveform acquisition across enabled channels.

It needs only explicit dependencies, conceptually:

```ts
new LiveWaveformService({
  driver,
  getScopeState,
  publishFrame,
})
```

Equivalent constructor parameters are fine.

Required dependencies are not optional:

- typed `Dho804Driver`
- `getScopeState(): ScopeState`
- `publishFrame(frame: Uint8Array): void`

Integration will pass the real state getter and WebSocket publication callback. Tests pass small fakes.

Do not import `WebSocketGateway` directly.

## Live point count

Start with:

```text
1000 points per NORMAL read
```

The DHO804 Programming Guide defines 1..1000 for NORMAL mode.

Keep the point count as one small service constant/config value so the real-scope benchmark can lower it easily if 1000 materially harms interaction latency.

Do not create a user preference/settings system for this initially.

## Live acquisition loop

The service is freshness-driven, not interval-log-driven.

A simple loop is:

1. obtain current `ScopeState`
2. find enabled channels
3. read one enabled channel through `driver.readLiveWaveform`
4. encode/publish that channel frame
5. before reading the next channel, allow the event loop/scheduler to service higher-priority work
6. continue cycling while live acquisition is wanted

Each channel read is a separate driver/scheduler operation. Do not wrap all enabled channels into one uninterruptible application operation.

## Live freshness state

Do not create a FIFO of requested cycles.

Internally track something equivalent to:

```text
running acquisition: yes/no
fresh waveform wanted: yes/no
```

If a freshness request arrives while the loop is already acquiring, set the one boolean marker. Do not enqueue another cycle object.

The SCPI scheduler has its own P3 live supersession; the service must also avoid an application-level backlog.

## Live scheduling cadence

Do not impose an arbitrary 10/20/30 Hz timer.

When clients want live data, acquire the next useful frame as soon as the driver/scheduler can do so without higher-priority work.

This naturally settles at the DHO804's useful rate.

If measurement later shows a reason to cap it, add a simple cap then.

## Live state conditions

Live NORMAL display should run while the scope is not in `ScopeRunState.Stopped`.

If the current state is stopped, stop requesting recurring live frames. The last browser waveform may remain displayed.

If no channel is enabled, remain idle until state changes.

Do not treat WAIT/TD/AUTO as disconnected states.

## Live sequence numbers

Maintain a `uint32` sequence per channel for live frames.

Increment each time a frame for that channel is published. Natural wrap is acceptable.

The browser uses it to ignore an older frame processed after a newer one.

## `DeepCaptureService`

The deep service owns one latest completed deep acquisition.

It needs:

- `Dho804Driver`
- no WebSocket objects
- no React/frontend state

A public API can be equivalent to:

```ts
capture(): Promise<DeepCaptureInfo>;
getViewport(request: DeepViewportRequest): Uint8Array;
```

where server-local request/result types contain only the data needed by the service.

Integration wraps `DeepCaptureInfo` into `DeepCaptureReadyMessage`.

## Deep capture preconditions

At the beginning of a capture:

1. call `driver.readScopeState(ScpiPriority.Normal)` to obtain fresh authoritative state
2. require `runState === ScopeRunState.Stopped`
3. collect currently enabled channels
4. require at least one enabled channel
5. use the authoritative acquisition `memoryDepth` as requested sample count

If the scope is running, reject the capture clearly. Do **not** silently send Stop as a side effect of asking for deep data.

The user can stop the scope or wait for Single to finish, then request the deep capture.

## Deep capture construction

For every enabled channel, call:

```ts
readRawWaveform(channel, memoryDepth)
```

sequentially.

The driver returns normalized `Float32Array` amplitude values and X metadata.

Build server-owned data equivalent to:

```ts
interface DeepChannelCapture {
  channel: Channel;
  unit: ChannelUnit;
  samples: Float32Array;
  xIncrement: number;
  xOrigin: number;
  xReference: number;
}

interface DeepCapture {
  id: number;
  channels: DeepChannelCapture[];
}
```

No fields are optional.

## Capture publication and replacement

Do not replace the currently retained completed capture until **all** selected channels of the new capture succeed.

Flow:

```text
previous capture retained
    |
start new temporary capture
    |
all channels succeed? -- no --> reject; keep previous
    |
   yes
    v
assign new positive capture ID
replace retained capture atomically
```

Version 1 retains exactly one completed capture.

A successful new capture invalidates the previous capture ID.

## Capture IDs

Use positive `uint32` IDs.

`0` is reserved by the binary protocol for live frames.

Increment for each successfully published deep capture. On wrap, skip zero and continue at `1`.

No UUID/string ID is needed for a single-process personal tool.

## Deep capture memory

Normalized Float32 storage is deliberate.

Worst DHO804 configurations are roughly:

- 25 Mpts single channel: 100 MB
- 2 × 10 Mpts: 80 MB total
- 4 × 5 Mpts: 80 MB total

Retaining one completed capture bounds the main waveform memory cost.

Do not add disk persistence, LRU caches or a capture database.

## Viewport request model

Server-local deep viewport input should mirror the shared JSON semantics:

```ts
interface DeepViewportRequest {
  captureId: number;
  channel: Channel;
  startSample: number;
  endSample: number;
  pixelWidth: number;
}
```

Validate:

- requested capture is the currently retained ID
- channel exists in the capture
- `0 <= startSample < endSample <= samples.length`
- positive integer `pixelWidth`

Do not clamp a wildly invalid request silently. Fail it.

## Overscan

The JSON request range is the visible range.

Expand it for cache overscan before downsampling.

Start with an overscan width of approximately 2x the requested source-sample width, centred around the requested range where capture bounds permit.

Example:

```text
visible width = end - start
wanted cached width ~= visible width * 2
```

Clamp the **expanded** range to capture boundaries.

Because the expanded range is wider than the visible range, scale the effective target pixel count proportionally:

```text
effectivePixels = ceil(
  pixelWidth * expandedRangeWidth / visibleRangeWidth
)
```

This preserves approximately the same sample/extrema density across the overscanned cached region.

The binary header reports the actual expanded source range.

## `downsample.ts`

Implement a pure function that accepts:

- `Float32Array` source
- half-open start/end indices
- target bucket count/effective pixels

and returns:

```ts
interface DownsampledWaveform {
  sampleIndices: Uint32Array;
  values: Float32Array;
}
```

### Near-raw path

If the source range is already small enough relative to target resolution, return every sample in the range.

A straightforward initial threshold is when source sample count is no greater than approximately `2 * targetPixels`.

Keep this threshold local/easy to benchmark.

### Min/max path

Otherwise divide the source range into horizontal buckets.

For each bucket:

1. scan every source sample
2. track minimum value/index
3. track maximum value/index
4. emit min/max in ascending source-index order
5. if they are the same index, emit once

Do not select every Nth source sample.

Do not sort the full output after the fact; emit bucket outputs already in time order.

Output indices must be absolute source indices into the retained capture, not indices relative to the viewport.

## Downsampling performance

Start with one linear scan per requested viewport.

Do not build a multiresolution pyramid initially.

The `testing.md` benchmark pass will determine whether scanning 25 M samples for a large viewport is materially expensive in Node.

Only add cached levels if measured viewport generation justifies them.

## Deep frame encoding

After overscan/downsampling, encode:

```text
kind = WaveformKind.DeepViewport
captureId = retained capture ID
sourceStartSample = expanded start
sourceEndSample = expanded end
point payload = downsampled absolute source indices + amplitude values
```

Use the channel capture's X metadata and unit.

Maintain a service-level uint32 frame sequence for deep viewport frames. It does not need to share live per-channel sequence state.

## Live frame encoding

A normalized live waveform is sequential.

Create indices:

```text
0, 1, 2, ... samples.length - 1
```

Encode:

```text
kind = WaveformKind.Live
captureId = 0
sourceStartSample = 0
sourceEndSample = samples.length
```

Use the driver-returned X metadata and channel unit.

Do not send DHO804 Y origin/reference fields to the browser.

## Integration seams

The workstream should export concrete services that final runtime composition can wire without editing these files.

Expected integration shape:

- `LiveWaveformService` publishes `Uint8Array` through a required callback
- `DeepCaptureService.capture()` returns capture metadata
- `DeepCaptureService.getViewport()` returns encoded `Uint8Array`

`WebSocketGateway` is responsible for attaching request IDs/message discriminants around service results and physically sending frames.

Do not import the gateway into waveform services.

## Tests

Follow `testing.md`.

Must cover:

### Frame encoder

- exact 64-byte header offsets
- little-endian values
- exact 8-byte records
- live/deep capture-ID rules
- invalid lengths/ranges/non-finite values

### Downsample

- one-sample positive glitch preserved
- one-sample negative glitch preserved
- min before max
- max before min
- equal min/max index emitted once
- constant waveform
- monotonic ramp
- near-raw path
- capture-boundary ranges

### Live service

- only enabled channels
- separate per-channel driver calls
- no FIFO cycle backlog
- stopped/no-channel idle behaviour
- per-channel sequence increment
- frame publication callback

### Deep service

- fresh state read at start
- rejects running scope
- rejects no enabled channels
- all enabled channels captured
- failed replacement preserves previous completed capture
- successful replacement invalidates old ID
- old capture ID viewport fails
- overscan range calculation
- effective pixel scaling
- viewport frame metadata

No physical scope is required for this workstream's normal tests.

## Non-goals

Do not implement:

- SCPI strings/native block parsing
- WORD byte interpretation
- scheduler
- scope state store/controller/poller
- WebSocket connections
- JSON protocol validation
- React/uPlot
- disk-persisted captures
- multiple retained captures
- multiresolution pyramid
- GPU/WebWorker downsampling

## Definition of done

This workstream is complete when:

1. live enabled-channel acquisition is freshness-driven and produces exact binary frames.
2. deep capture requires stopped state, captures all enabled channels and retains only the latest successful capture.
3. failed new captures do not destroy the previous completed capture.
4. min/max viewport downsampling preserves narrow extrema and temporal order.
5. viewport responses include approximately 2x overscan with proportional output density.
6. binary encoding exactly matches `waveform-protocol.md`.
7. services expose narrow callback/method seams for integration and do not import WebSocket transport.
8. focused tests pass.
9. `pnpm typecheck` and `pnpm test` pass.
10. No SCPI/backend, server-control or frontend ownership boundaries were crossed.