# Frontend Architecture

## Goals

The frontend serves two fixed instrument routes while keeping the existing DHO804 interaction path fast:

- `/` — DHO804 oscilloscope
- `/dm858e` — DM858E digital multimeter

The browser keeps one application-level WebSocket alive while navigating between these routes. Instrument state remains separate; adding the DM858E must not turn `scope-store.ts` into a mixed generic instrument store.

## Stack

- TypeScript
- React
- React Router
- Vite
- Zustand for instrument/application state
- uPlot for DHO804 waveform rendering
- one persistent WebSocket to the Rigol Web server

## Application shell and routing

`BrowserRouter` is mounted at the application root. `App` owns the persistent `ScopeWebSocketClient` instance and renders route elements through `Routes`/`Route`, with `NavLink` for the instrument switcher.

The WebSocket client is created above the route elements, so navigation between `/` and `/dm858e` does not recreate it.

Each route owns its instrument subscription:

```text
Scope route mount     -> subscribe DHO804
Scope route unmount   -> unsubscribe DHO804

DM858E route mount    -> subscribe DM858E
DM858E route unmount  -> unsubscribe DM858E
```

The server reference-counts subscriptions across browser sessions, so one tab leaving a route does not stop an instrument still used by another tab.

Production static serving must return `index.html` for the known application routes so direct navigation/refresh works with `BrowserRouter`, while missing asset paths still return normal 404s.

## Shared browser transport state

WebSocket transport state is separate from either instrument's device lifecycle.

The shared client exposes:

```ts
export enum BrowserTransportKind {
  Connecting = 1,
  Connected = 2,
  Disconnected = 3,
}
```

`Connected` means the WebSocket is open **and** the application-level protocol hello has completed successfully.

Both route/store implementations must react to transport loss. A prior `DmmConnected` or valid DMM reading must not remain visually indistinguishable from live data after the browser/server socket is lost.

Instrument lifecycle and transport lifecycle answer different questions:

- transport: can this browser currently communicate with Rigol Web?
- instrument: is the selected physical instrument/runtime connected and usable?

Do not collapse them into a single optional object.

## WebSocket handshake

The browser does not send instrument subscriptions on raw socket open.

Sequence:

```text
WebSocket open
  -> wait for ProtocolHello
  -> require matching PROTOCOL_VERSION
  -> send ProtocolHelloAck
  -> mark shared transport Connected
  -> send currently desired instrument subscriptions
```

Application commands fail locally while the protocol handshake is incomplete.

On reconnect, desired route subscriptions remain remembered and are resent only after the new handshake succeeds.

## Instrument state separation

### DHO804

The existing `scope-store.ts` remains scope-specific. It owns:

- scope connection/device lifecycle
- complete authoritative `ScopeState`
- measurement selections/results
- deep-capture lifecycle metadata
- scope UI errors/presentation state

Do not insert DM858E state into this store.

### DM858E

Workstream D creates a separate DMM store using the shared contracts from `dmm-types.ts` and `websocket-protocol.ts`.

It should own:

- DM858E connection lifecycle
- complete authoritative `DmmState`
- latest primary reading
- pending/request state needed for controls
- DMM-specific UI state

It must also consume shared browser transport state so transport loss invalidates connected/reading presentation immediately.

## DHO804 waveform separation

DHO804 waveform sample arrays do not belong in React state or Zustand.

```text
WebSocket
   |
   +---- JSON scope state/control ----> scope Zustand store ----> React
   |
   `---- binary waveform ------------> waveform layer ---------> uPlot
```

A new waveform must not require rerendering the React application.

DM858E readings are JSON messages and do not use the DHO804 binary waveform path.

## WebSocket message ownership

The shared client owns:

- transport connection/reconnect
- protocol hello/version validation
- desired instrument subscriptions
- request IDs and request/result correlation
- dispatch of DHO804 lifecycle into the scope store
- a DMM lifecycle/data listener boundary used by the DMM route/store
- shared transport-state listeners
- binary DHO804 waveform decoding/dispatch

Components should use typed client methods rather than constructing numeric protocol discriminants manually.

Raw SCPI calls require an explicit `SupportedInstrument`; there is no default scope target.

## DHO804 connection model

The existing scope store may retain its scope-specific discriminated union:

```ts
export enum BrowserConnectionKind {
  Connecting = 1,
  TransportDisconnected = 2,
  ScopeDisconnected = 3,
  ScopeConnected = 4,
}
```

This remains useful for the existing DHO804 UI, but new cross-instrument code should use the shared transport-state boundary rather than treating the scope store as global application state.

Required connected scope fields stay non-optional.

## uPlot ownership

Create one uPlot instance for the mounted DHO804 waveform view and update it imperatively.

Use uPlot mode 2 so each channel can carry independent X/Y arrays. Keep fixed series slots for CH1-CH4 and use empty arrays for channels without current display data.

## Scope-like scales

The DHO804 has 10 horizontal and 8 vertical divisions.

For normal YT/Main display:

```ts
xMin = horizontal.position - 5 * horizontal.scale;
xMax = horizontal.position + 5 * horizontal.scale;
```

Per-channel Y range:

```ts
yMin = -channel.offset - 4 * channel.scale;
yMax = -channel.offset + 4 * channel.scale;
```

Do not auto-range channel Y scales from waveform values.

## DHO804 interactive fast path

Continuous pointer interaction must not wait for a scope round trip.

During a drag:

1. update local visual state immediately
2. send `InteractionUpdate`
3. allow server-side scheduler coalescing
4. keep rendering without waiting for acknowledgement

At interaction end:

1. send `InteractionCommit`
2. keep the final optimistic value visible
3. reconcile from authoritative scope state/readback

Initial continuous controls include channel offset, trigger level and horizontal position.

Do not add arbitrary client-side rate limiting without measurement.

## Direct waveform interactions

Use HTML/React overlay handles around the uPlot area where practical.

Initial mappings:

- plot-background horizontal drag -> horizontal position
- per-channel ground marker drag -> channel offset
- Edge trigger-level marker drag -> trigger level

Keep pixel/domain conversion in tested functions.

For plot width `W`:

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

## DHO804 binary waveform handling

The browser binary frame contains waveform kind, channel, sequence, capture metadata, X mapping, unit and indexed Float32 amplitudes.

For each payload point:

```ts
x = xOrigin + (sampleIndex - xReference) * xIncrement;
```

Keep only the newest useful live frame per channel. Ignore stale sequence numbers and do not queue waveform history.

## Authoritative instrument state

Physical instruments remain authoritative.

For the DHO804, the browser may be optimistic during interaction but complete server `ScopeState` snapshots replace authoritative scope state.

For the DM858E, workstream D should follow the same principle for discrete controls: local presentation may be optimistic, but later complete `DmmState` from the backend wins.

Do not create a generic partial-patch merge layer for both instruments.

## DHO804 measurements

Measurements are dynamic request/result data, not members of `ScopeState`.

Request only displayed measurements, initially around 1 Hz with no overlapping request. Format amplitude results using the source channel unit and frequency/time using SI prefixes.

## DHO804 deep capture

The browser does not hold the complete RAW acquisition.

After successful capture it receives metadata, requests display-sized source ranges, caches overscanned decoded windows and requests replacements as the viewport approaches cache edges.

Panning/zooming a retained capture never re-reads the DHO804.

See `waveforms.md` and `waveform-protocol.md`.

## DM858E frontend handoff

Workstream D owns the finished meter UI under `src/web/dmm/**` and `src/web/components/dmm/**`.

The foundation already provides:

- `/dm858e` React Router route and mount/unmount lifecycle
- shared transport state
- DMM lifecycle/data listener boundary
- typed DMM state/control/reading contracts
- instrument subscription messages
- instrument-targeted raw SCPI

Workstream D should build on those boundaries, not redesign the global router or WebSocket lifecycle.

## Performance rules

- keep one application WebSocket across route changes
- waveform samples bypass React state
- reuse one uPlot instance while the scope view is mounted
- keep interaction optimistic
- do not block pointer handling on WebSocket/SCPI round trips
- keep live/deep waveform caches bounded/latest-oriented
- do not retain stale DMM connected/readout presentation after transport loss
- measure before adding throttles or rendering machinery
