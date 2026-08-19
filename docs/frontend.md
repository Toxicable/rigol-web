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
- acquisition run/stop state
- channel enable state
- channel scale and offset
- horizontal settings
- trigger settings
- measurements
- UI configuration

Components should subscribe only to the state they actually render.

Do not model required connected-scope state with optional fields. Prefer discriminated unions for genuinely different application states.

Example:

```ts
type ConnectionState =
  | { kind: "disconnected" }
  | {
      kind: "connected";
      scope: ScopeState;
    };
```

Avoid:

```ts
type ConnectionState = {
  connected: boolean;
  scope?: ScopeState;
};
```

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

## uPlot ownership

Each waveform view creates a uPlot instance when mounted and keeps that instance alive.

New data updates the existing plot imperatively rather than recreating the chart.

```text
mount
  -> create uPlot

new waveform
  -> transform/display data
  -> uPlot.setData(...)
```

uPlot is responsible for plotting, axes, grid, cursor behaviour and basic pan/zoom behaviour.

Scope-specific controls, labels, buttons and draggable handles remain normal HTML/React UI where practical.

## Interactive fast path

Continuous pointer interaction must not wait for a scope round trip.

During a drag:

1. update the local visual state immediately
2. send the newest desired value to the server
3. allow the SCPI scheduler to coalesce intermediate values
4. continue rendering without waiting for acknowledgement

When the interaction ends:

1. send the final value at highest scheduler priority
2. read the value back from the scope
3. reconcile authoritative state

This applies to controls such as:

- channel offset
- trigger level
- horizontal position
- other continuous waveform controls

Do not add an arbitrary client-side interaction rate limit unless measurement shows one is needed.

## Authoritative state

The browser is optimistic during interaction, but the physical scope remains authoritative.

The server sends complete `ScopeState` snapshots when authoritative state changes. The frontend replaces its authoritative scope state rather than merging bags of optional patches.

The approximately 1 Hz scope-state validation poll is handled by the server. Active interactive properties must not visibly jump backwards due to stale validation results.

## Deep-capture interaction

The browser does not hold the complete raw deep acquisition by default.

The server owns the full acquisition and returns display-resolution windows. The browser caches an overscanned region around the visible viewport so small pans can remain local and immediate.

See `waveforms.md` for the deep-capture data path.

## Performance rules

- waveform samples bypass React state
- reuse uPlot instances
- prefer typed arrays for waveform data
- avoid unnecessary allocation in live update paths
- keep interaction optimistic
- do not block pointer handling on WebSocket or SCPI responses
- measure before introducing throttles or more complex rendering machinery
