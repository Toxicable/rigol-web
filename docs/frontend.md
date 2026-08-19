# Frontend Architecture

## Goals

The frontend should feel more responsive than the physical DHO804 UI, particularly during continuous interactions such as waveform dragging, channel offset adjustment and trigger-level movement.

The main UI and waveform data paths are deliberately separated so high-rate waveform updates do not cause React render churn.

## Stack

- TypeScript
- React
- Vite
- Zustand for application/scope state
- uPlot for waveform rendering
- one persistent WebSocket to the Rigol Web server

## State separation

There are two distinct classes of frontend data.

### Application and scope state

React/Zustand owns relatively small state such as:

- scope connection state
- complete authoritative `ScopeState`
- measurement selections/results
- deep-capture lifecycle metadata
- small UI state

Components should subscribe only to the state they actually render.

Do not model required connected-scope state with optional fields. Use numeric enums and discriminated unions for genuinely different application states.

Example:

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

Avoid designs such as:

```ts
interface ConnectionState {
  connected: boolean;
  scope?: ScopeState;
}
```

The concrete scope/domain types are defined in `scope-model.md`.

### Waveform data

Waveform sample arrays do not belong in React state or Zustand.

Waveforms are delivered directly to a dedicated waveform/capture layer and then into the existing uPlot instance.

```text
WebSocket
   |
   +---- JSON state/control ----> Zustand ----> React UI
   |
   +---- binary waveform ------> waveform layer ----> uPlot
```

A new waveform must not require rerendering the React application.

## WebSocket protocol

Use one browser WebSocket with:

```ts
socket.binaryType = "arraybuffer";
```

Text frames follow `websocket-protocol.md`.

Binary frames follow `waveform-protocol.md`.

The browser uses shared numeric enums and message types. Components do not manually construct protocol discriminator numbers.

Intermediate interaction updates do not wait for acknowledgements. Discrete commands and final commits use request IDs for completion/failure association.

## uPlot ownership

Create one uPlot instance for the waveform view and keep it alive.

New data updates the existing plot imperatively rather than recreating the chart.

```text
mount
  -> create uPlot

new waveform
  -> decode/transform display data
  -> uPlot.setData(...)
```

Use uPlot **mode 2** so each channel can have independent X/Y arrays. This is important for deep min/max data because extrema from different channels do not necessarily occur at identical source sample indices.

The official uPlot mode-2 pattern uses independent `[xValues, yValues]` arrays per series, which matches the indexed waveform protocol well.

Keep fixed series slots for CH1 through CH4 and use empty arrays for channels without current display data rather than rebuilding the plot definition.

## Scope-like scales

The DHO804 has 10 horizontal and 8 vertical divisions.

For normal YT/Main display, use:

```ts
xMin = horizontal.position - 5 * horizontal.scale;
xMax = horizontal.position + 5 * horizontal.scale;
```

Each channel gets its own Y scale:

```ts
yMin = -channel.offset - 4 * channel.scale;
yMax = -channel.offset + 4 * channel.scale;
```

Do not auto-range channel Y scales from waveform values. V/div and offset are scope state.

The exact visual sign/position mapping should be cross-checked once against the real DHO804 during integration rather than growing a configurable abstraction around it.

## Interactive fast path

Continuous pointer interaction must not wait for a scope round trip.

During a drag:

1. update the local visual state immediately
2. send `InteractionUpdate` with the newest desired value
3. allow the server/SCPI scheduler to coalesce intermediate values
4. continue rendering without waiting for acknowledgement

When the interaction ends:

1. send `InteractionCommit` with the final value
2. keep the final optimistic value visible
3. reconcile the later authoritative scope snapshot/readback

This applies initially to:

- channel offset
- trigger level
- horizontal position

The protocol can also carry scale interactions if gesture-driven scale control is added later.

Do not add an arbitrary client-side interaction rate limit unless measurement shows one is needed.

## Direct waveform interactions

Use HTML/React overlay handles around the uPlot plotting area where practical.

Initial direct interactions:

- plot-background horizontal drag -> horizontal position
- per-channel ground marker drag -> channel offset
- Edge trigger-level marker drag -> trigger level

Keep pixel-to-domain conversion in small tested functions.

For a plot width `W`:

```ts
newHorizontalPosition =
  startPosition - dx * (10 * horizontalScale) / W;
```

For plot height `H`:

```ts
newChannelOffset =
  startOffset - dy * (8 * channelScale) / H;

newTriggerLevel =
  startLevel - dy * (8 * sourceChannelScale) / H;
```

Do not render Edge-specific trigger handles while the scope is using another trigger type.

## Binary waveform data

The server already converts native DHO804 waveform codes into Float32 amplitude values in the channel's current amplitude unit.

The browser frame contains:

- waveform kind
- channel
- sequence
- capture ID
- represented source sample range
- X increment/origin/reference
- channel amplitude unit
- source sample index + Float32 amplitude records

The browser does not know about Rigol TMC headers, native WORD/BYTE encoding or Y-origin/reference code conversion.

For each payload point:

```ts
x = xOrigin + (sampleIndex - xReference) * xIncrement;
```

Build display-sized X arrays after decoding.

## Live waveform handling

Keep only the newest useful live frame per channel.

Use the frame sequence number to ignore stale frames.

Do not queue waveform history in the browser.

A live frame updates the waveform controller/uPlot directly, not Zustand.

## Authoritative state

The browser is optimistic during interaction, but the physical scope remains authoritative.

The server sends complete `ScopeState` snapshots when authoritative state changes. The frontend replaces its authoritative scope state rather than merging bags of optional patches.

The approximately 1 Hz scope-state validation poll is handled by the server. Active interactive properties must not visibly jump backwards due to stale validation results.

## Measurements

Measurements are dynamic request/result data, not members of `ScopeState`.

Keep the user's selected `MeasurementSpec[]` and latest result array in application state.

Request only the measurements being displayed, initially around 1 Hz with no overlapping request.

Format amplitude results using the source channel's `ChannelUnit`; format frequency/time with SI prefixes.

## Deep-capture interaction

The browser does not hold the complete raw deep acquisition.

After an explicit successful deep capture, the server returns capture metadata and the browser requests display-resolution source ranges.

The server response is overscanned. Cache that decoded window per channel so small pans remain local and immediate.

When the desired visible range approaches the cache edge, request a replacement viewport in the background.

A stale viewport response can be ignored if a newer desired range has superseded it.

Panning/zooming within a retained deep capture never re-reads the DHO804.

See `waveforms.md` and `waveform-protocol.md`.

## Performance rules

- waveform samples bypass React state
- reuse one uPlot instance
- use mode 2 for independent per-channel X arrays
- prefer typed arrays in waveform code
- keep interaction optimistic
- do not block pointer handling on WebSocket or SCPI responses
- keep live/deep waveform caches bounded/latest-oriented
- measure before introducing throttles or more complex rendering machinery

## Implementation handoff

The detailed frontend file ownership, controls, decoder behaviour and tests are specified in `workstreams/frontend.md`.