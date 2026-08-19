# Frontend Implementation Workstream

## Audience

This handoff covers the browser application after foundation has landed.

It owns React/Zustand application state, WebSocket client behaviour, binary waveform decoding, uPlot rendering and version 1 controls.

It does not own server WebSocket routing, SCPI, deep-capture generation/downsampling or final server runtime composition.

## Read first

Read:

- `docs/architecture.md`
- `docs/development-practices.md`
- `docs/typescript-practices.md`
- `docs/scope-model.md`
- `docs/frontend.md`
- `docs/websocket-protocol.md`
- `docs/waveform-protocol.md`
- `docs/waveforms.md`
- `docs/testing.md`

The shared files created by foundation are the browser/server compile-time contract. Do not duplicate their numeric enum values locally.

## File ownership

This workstream owns all normal browser files under:

```text
src/web/**
```

This includes editing the foundation placeholders:

```text
src/web/app.tsx
src/web/main.tsx
```

A practical initial layout is:

```text
src/web/
|- app.tsx
|- main.tsx
|- styles.css
|- scope-store.ts
|- scope-store.test.ts
|- websocket-client.ts
|- websocket-client.test.ts
|- format-value.ts
|
|- waveform/
|  |- waveform-frame-decoder.ts
|  |- waveform-frame-decoder.test.ts
|  |- waveform-controller.ts
|  |- waveform-controller.test.ts
|  `- waveform-plot.tsx
|
`- components/
   |- scope-toolbar.tsx
   |- channel-controls.tsx
   |- horizontal-controls.tsx
   |- trigger-controls.tsx
   |- measurement-panel.tsx
   `- scpi-console.tsx
```

This split is guidance, not a requirement to create one component per tiny piece. Keep components understandable and avoid a design-system abstraction.

Do not edit:

- `src/server/**`
- `src/shared/**`
- root build/package files

The integration workstream can update Vite proxy/runtime settings later without making this branch contend for root files.

## No component library

Use React and ordinary CSS.

Do not add a component library, CSS framework, icon package or chart wrapper.

uPlot is used directly.

## Browser connection state

Do not represent connection lifecycle with optional scope fields.

Use a numeric enum and discriminated union, for example:

```ts
export enum BrowserConnectionKind {
  Connecting = 1,
  TransportDisconnected = 2,
  ScopeDisconnected = 3,
  ScopeConnected = 4,
}

export type BrowserConnection =
  | {
      kind: BrowserConnectionKind.Connecting;
    }
  | {
      kind: BrowserConnectionKind.TransportDisconnected;
      reason: string;
    }
  | {
      kind: BrowserConnectionKind.ScopeDisconnected;
      reason: string;
    }
  | {
      kind: BrowserConnectionKind.ScopeConnected;
      info: ScopeInfo;
      scope: ScopeState;
    };
```

A connected variant always contains a complete `ScopeInfo` and `ScopeState`.

## Zustand scope store

Zustand contains ordinary application/control state, not high-rate waveform samples.

A suitable shape includes:

- `connection: BrowserConnection`
- configured measurement specs
- latest ordered measurement results
- deep-capture lifecycle metadata

Do not put `Float32Array`, decoded waveform points or uPlot data arrays in Zustand.

### Deep-capture UI state

Use an explicit union rather than optional capture fields:

```ts
export enum DeepCaptureKind {
  None = 1,
  Capturing = 2,
  Ready = 3,
}

export type DeepCaptureState =
  | {
      kind: DeepCaptureKind.None;
    }
  | {
      kind: DeepCaptureKind.Capturing;
      requestId: number;
    }
  | {
      kind: DeepCaptureKind.Ready;
      captureId: number;
      channels: DeepCaptureChannelInfo[];
    };
```

Sample buffers remain in the waveform controller, not this state.

## Authoritative state handling

`ScopeConnected` supplies the first complete snapshot.

Every later `ScopeState` message replaces the connected `scope` snapshot as a whole.

Do not merge partial patches because the protocol deliberately does not send them.

During an interactive gesture, the browser remains optimistic for the active visual control until the next authoritative state snapshot/readback arrives. The store should support explicitly applying the local desired value to the current complete snapshot rather than waiting for the server round trip.

Write small semantic update functions. Do not implement `setByPath()` or string-key mutation.

## WebSocket client

Create one browser WebSocket connection.

Use the same-origin `/ws` endpoint. The integration workstream owns dev proxy/production serving so frontend code does not need environment-specific server URLs.

Immediately set:

```ts
socket.binaryType = "arraybuffer";
```

Text frames contain JSON server messages. Binary frames go straight to the waveform controller.

Do not decode binary data through React/Zustand.

## Request IDs

Maintain a simple monotonically increasing non-negative integer request ID in the WebSocket client.

No UUID is needed.

Wrap naturally only after reaching the largest safe integer you choose to support; a simple reset when no requests are pending is sufficient if ever needed. Do not build an ID service.

Request/response promises are useful for discrete commands and explicit deep capture. Intermediate interactions do not use them.

## JSON message sending

Expose typed methods rather than letting components call `socket.send(JSON.stringify(...))` directly.

The client should have clear operations equivalent to:

- set control
- interaction update
- interaction commit
- Run/Stop/Single
- measurement read
- deep capture request
- deep viewport request
- raw SCPI execute

Methods accept the shared domain/protocol types.

Do not construct numeric message-type values in components.

## Continuous control behaviour

For drag interactions:

### Pointer down

- capture the pointer
- record the starting authoritative/optimistic control value
- record geometry needed for pixel-to-domain conversion

### Pointer move

- calculate the desired current domain value
- update the browser state/visual immediately
- send `InteractionUpdate`
- do not wait for a response

### Pointer up/cancel

- calculate/send the final desired value as `InteractionCommit`
- keep the optimistic value visible
- let the later authoritative scope snapshot reconcile rounding/clamping

Do not send a `ControlSet` for every pointer move.

Do not apply an arbitrary browser-side 10/20/30 Hz throttle initially. Pointer events may arrive faster than the DHO804 can consume; server scheduling/coalescing is designed for that.

If browser rendering itself becomes the bottleneck, coalesce DOM/plot redraw to animation frames while still preserving the latest desired value.

## Waveform binary decoder

`waveform-frame-decoder.ts` implements the browser side of exactly `docs/waveform-protocol.md`.

It must validate:

- magic
- version
- header size
- kind
- channel
- encoding
- channel unit
- represented source range
- point count versus actual frame byte length
- every source index inside the represented range
- finite X metadata and amplitude values

Return a required-field structure equivalent to:

```ts
export interface DecodedWaveformFrame {
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

For simplicity and safety, copying the strided binary records into contiguous typed index/value arrays is acceptable. These frames are display-sized, not 25-million-point RAW captures.

Do not expose `DataView`/header offsets to React components.

## X conversion

Convert each source sample index to a real X value with:

```ts
x = xOrigin + (sampleIndex - xReference) * xIncrement;
```

Build the small display-sized X array in the waveform controller when preparing uPlot data.

Do not send millions of derived X values across the WebSocket.

## Waveform controller

Create one non-React controller/object that owns live and deep waveform buffers.

It should:

- accept decoded binary frames
- keep the latest live frame per channel
- ignore stale live sequence values
- keep the current deep viewport cache per channel/capture
- know the currently desired deep visible range
- request a new deep viewport when the visible range approaches/exceeds overscan cache boundaries
- notify the uPlot wrapper to redraw using current display-sized arrays

This controller must not be a Zustand store.

A small callback subscription from controller to plot wrapper is enough.

## uPlot mode

Use uPlot **mode 2** so each channel can carry its own X/Y arrays.

This matters because server min/max downsampling preserves each channel's actual extrema indices; two channels are not guaranteed to emit extrema at the same source sample positions.

uPlot's official mode-2 scatter example uses data shaped as a series of independent `[xValues, yValues]` arrays with the first entry `null`, which is the useful model here.

Conceptually maintain fixed slots for all four channels:

```text
[
  null,
  [ch1X, ch1Y],
  [ch2X, ch2Y],
  [ch3X, ch3Y],
  [ch4X, ch4Y],
]
```

Use empty X/Y arrays for a channel with no current display data rather than rebuilding the entire plot's series definition.

Create the uPlot instance once and call `setData`/scale updates imperatively.

Do not recreate uPlot on every React render or every waveform frame.

## Plot scales

The DHO804 has 10 horizontal and 8 vertical divisions.

### Horizontal visible range

For the ordinary YT/Main view, use the scope's current horizontal state:

```ts
xMin = horizontal.position - 5 * horizontal.scale;
xMax = horizontal.position + 5 * horizontal.scale;
```

The DHO800 User Guide defines positive horizontal position as the trigger point being to the left of display centre, which is consistent with the viewport centre being the positive `horizontal.position` value in trigger-relative time.

### Per-channel Y scale

Give each channel its own uPlot Y scale so V/div and offset remain scope-like even with overlapping traces.

For a channel:

```ts
yMin = -channel.offset - 4 * channel.scale;
yMax = -channel.offset + 4 * channel.scale;
```

This matches the DHO trigger-level relation that uses `VerticalScale` around `-Offset`.

The initial frontend should treat this mapping as a DHO804 display convention and include a focused real-scope visual check during integration. Do not build alternative sign modes.

Do not auto-range Y from waveform values. Scope V/div/offset are authoritative.

## Grid

Render a scope-like 10 × 8 graticule.

It is acceptable to use uPlot grid/axes plus lightweight custom drawing hooks where necessary. Do not create a custom Canvas waveform renderer instead of uPlot.

Avoid a large chart abstraction around uPlot.

## Direct plot interactions

Version 1 should include the interactions that motivated the low-latency scheduler.

### Horizontal pan

Dragging the plot background horizontally adjusts `HorizontalPosition`.

With plot width `W`, horizontal scale `s` and pointer movement `dx`:

```ts
secondsPerPixel = (10 * s) / W;
newPosition = startPosition - dx * secondsPerPixel;
```

This is a grab/pan gesture: dragging content right moves the viewed time centre earlier.

Send intermediate `InteractionUpdate` and final `InteractionCommit`.

### Channel offset handles

Render a draggable ground/reference marker for each enabled channel at amplitude `0` on that channel's Y scale.

Dragging a marker vertically changes that channel's offset.

For plot height `H`, channel scale `s` and pointer movement `dy`:

```ts
unitsPerPixel = (8 * s) / H;
newOffset = startOffset - dy * unitsPerPixel;
```

Dragging the ground marker upward therefore increases offset.

### Trigger level handle

When trigger type is Edge, render a draggable trigger-level marker using the selected source channel's Y scale.

```ts
unitsPerPixel = (8 * source.scale) / H;
newLevel = startLevel - dy * unitsPerPixel;
```

Send `TriggerLevel` interaction updates/commit.

Do not render or enable this Edge-specific direct control when trigger type is not Edge.

### Scale controls

Version 1 may use explicit buttons/numeric controls for vertical and horizontal scale instead of gesture zoom. The protocol already allows scale to become interactive later if pinch/wheel zoom is added.

Do not add complex cursor-anchored zoom behaviour before it is needed.

## Channel controls

Provide clear controls for CH1 through CH4:

- enabled
- vertical scale
- vertical offset
- coupling display
- probe ratio display
- amplitude unit display

Version 1 only needs to write enable, scale and offset. Coupling/probe ratio/unit remain authoritative display state unless a later UI change is explicitly added.

Use the `Channel` enum as identity. Do not identify channels by array index in event payloads.

## Horizontal controls

Display/control:

- time/div
- horizontal position
- current mode Main/Roll/XY
- sample rate
- memory depth

Version 1 writes scale and position only.

If the physical scope changes to XY or Roll, show that state clearly. Do not pretend the ordinary YT waveform controls are still fully applicable. Disable incompatible direct pan controls until Main mode returns.

## Trigger controls

Display current trigger type and sweep mode.

Version 1 configuration UI supports Edge trigger:

- button/action to select Edge trigger
- source CH1-CH4
- slope rising/falling/either
- level
- coupling display

If current type is another supported trigger type, show its name and offer the explicit switch-to-Edge action. Do not fabricate missing Edge settings from stale prior UI values.

## Run controls

Provide:

- Run
- Stop
- Single

Use `AcquisitionActionMessage`.

Display the full `ScopeRunState` rather than a boolean so WAIT/T'D/AUTO/STOP/RUN are visible.

## Measurements

Provide a small measurement panel using the initial `MeasurementKind` values.

The UI can let the user add/remove measurement specs by channel and kind.

Keep configured specs in Zustand as a complete array. Empty array means no measurements requested.

When non-empty:

- request only those specs
- start at approximately 1 Hz
- do not start another measurement request while the previous one is outstanding
- preserve response order

Format:

- Frequency -> Hz with SI prefixes
- Period -> seconds with SI prefixes
- amplitude measurements -> selected channel's `ChannelUnit`

Do not put changing measurement values into `ScopeState`.

## SCPI console

Provide a compact raw SCPI console:

- command input
- execute action
- chronological text history
- request failure displayed visibly

No terminal emulation library is needed.

A no-response command should show successful completion with an empty response rather than waiting forever.

Binary SCPI console queries are outside version 1 and should surface the server's clear rejection.

## Deep capture UX

Provide an explicit `Deep Capture` action.

Only enable it when authoritative scope run state is `Stopped`.

On success, store `DeepCaptureReady` metadata in `DeepCaptureState.Ready` and request viewport data for the current visible range/channel(s).

Do not assume pressing Deep Capture implicitly stops the scope.

## Deep viewport/cache behaviour

For each captured channel, retain the latest decoded deep viewport frame in the waveform controller.

A frame's header tells you its actual overscanned source range.

When panning/zooming:

- if the desired visible source range remains comfortably inside cached range, redraw locally
- when approaching the cache boundary, request another viewport
- if a newer viewport is desired, ignore an older response that no longer covers the desired view

Do not request a server window for every pointer move.

The browser should not attempt to reconstruct unavailable full-resolution deep data from downsampled frames.

## Deep source-range conversion

The browser often works in X/time values while the protocol requests sample indices.

Given channel capture X metadata from the current cached frame:

```ts
sampleIndex = (x - xOrigin) / xIncrement + xReference;
```

Convert visible X min/max to integer sample bounds and clamp to the capture's `sampleCount` from `DeepCaptureReady`.

Use floor for start and ceil for end so the full visible time region is covered.

The server remains authoritative and validates the final request.

## Live versus deep display

Keep one waveform plot.

- while running, display latest live frames
- after explicit deep capture, switch the plot's data source to deep viewport frames
- Run should return the display to live mode

Model this as an explicit numeric display-mode enum if useful. Do not infer it from whether some optional deep buffer happens to exist.

## Formatting

Use small single-purpose SI formatting functions.

Support at least:

- seconds
- hertz
- volts/amps/watts/unknown amplitude units
- Sa/s
- samples

Do not use fixed decimal counts that make nanoseconds or millivolts unreadable.

No imperial/Fahrenheit units are relevant anywhere.

## Error behaviour

Visible failures should be visible.

Do not swallow:

- WebSocket protocol errors
- command failures
- deep-capture failures
- malformed binary frames

A malformed disposable live frame can be dropped after surfacing/logging the error. Repeated binary protocol corruption should close/recreate the WebSocket rather than continuing with uncertain interpretation.

Keep error presentation simple; no global notification framework is needed.

## Tests

Follow `docs/testing.md`.

Required cases:

### Store/client

- numeric connection union transitions
- full `ScopeState` replacement
- optimistic semantic state update
- request ID association
- interaction updates do not await acknowledgement
- final commit sends request ID
- measurement polling does not overlap

### Binary decoder

- fixed fixture matches every documented header offset
- little-endian parsing
- strided record extraction
- frame length mismatch rejection
- bad magic/version/encoding/unit rejection
- invalid source index rejection

### Waveform controller

- stale live sequence ignored
- newest live frame retained independently per channel
- deep cache used for small pan
- viewport request triggered near boundary
- stale deep response ignored when it does not satisfy newer desired viewport
- sample-index/time conversion

### Interaction math

- horizontal pixel drag to position
- vertical channel drag to offset
- trigger level drag
- signs and division scaling

### React

Only add component tests where they prove meaningful wiring/visibility. Avoid broad snapshots.

## Non-goals

Do not implement:

- server code
- SCPI strings
- scheduler
- waveform downsampling
- binary frame encoding
- a custom waveform Canvas renderer
- component/design-system framework
- complex touch gesture library
- auth/login
- arbitrary instrument selection
- persistence of UI layout/settings

## Definition of done

This workstream is complete when:

1. browser WebSocket client handles all finalized JSON/binary protocol messages with shared types.
2. Zustand contains complete application/scope state but no waveform sample arrays.
3. binary waveform decoder exactly matches `waveform-protocol.md`.
4. one persistent uPlot instance renders four independently indexed channel series using mode 2.
5. live stale frames are ignored and deep overscan cache supports local panning.
6. horizontal pan, channel-offset drag and Edge trigger-level drag use optimistic `InteractionUpdate`/`InteractionCommit` semantics.
7. v1 channel/horizontal/Edge/run/measurement/SCPI/deep-capture controls are functional against a mocked WebSocket transport.
8. tests cover protocol decoding, state flow and interaction math.
9. `pnpm typecheck` and `pnpm test` pass.
10. no server or shared-contract ownership boundary was crossed.