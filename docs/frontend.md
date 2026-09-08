# Frontend Architecture

## Purpose

The browser serves two fixed instrument routes while keeping one application transport connection alive across navigation:

- `/` — DHO804 oscilloscope
- `/dm858e` — DM858E digital multimeter

The browser architecture is concrete rather than a generic instrument framework. Scope and DMM keep separate domain stores and bindings.

## Top-level ownership

```text
React App
  |
  +-> AppConnection
  |     - WebSocket connect/reconnect
  |     - protocol handshake
  |     - request IDs/correlation
  |     - desired publication subscriptions
  |     - JSON/binary transport fanout
  |     - shared transport state
  |
  +-> ScopeBinding
  |     - DHO804 lifecycle/state projection
  |     - scope request construction
  |     - waveform decode/controller handoff
  |     - scope publication subscription
  |
  `-> DmmBinding
        - DM858E lifecycle/state/snapshot projection
        - DMM request construction
        - DMM publication subscription
```

`App` constructs one `AppConnection` above the route elements. Route navigation does not recreate it. `ScopeBinding` and `DmmBinding` are also application-owned and remain alive while their route is unmounted; route mount/unmount only calls `activate()` / `deactivate()`.

The obsolete scope-shaped global `ScopeWebSocketClient` no longer exists.

## Shared transport state

`src/web/app-transport-store.ts` is the single owner of browser/server transport state:

```ts
export enum AppTransportKind {
  Connecting = 1,
  Connected = 2,
  Disconnected = 3,
}
```

`Connected` means the WebSocket has completed the application protocol handshake, not merely that the TCP/WebSocket socket opened.

Scope and DMM stores do not duplicate WebSocket connecting/disconnected state. They represent the selected physical instrument/domain presentation only. When shared transport leaves `Connected`, active bindings invalidate stale instrument presentation by returning their instrument store to its awaiting-instrument state.

Transport and physical instrument lifecycle answer different questions:

- transport: can this browser communicate with Rigol Web?
- instrument: is the selected physical instrument connected and usable?

Do not merge those into one generic state object.

## Protocol handshake and reconnect

`AppConnection` performs:

```text
connect
  -> wait for ProtocolHello
  -> require matching PROTOCOL_VERSION
  -> send ProtocolHelloAck
  -> publish AppTransportKind.Connected
  -> resend desired instrument subscriptions
```

Application messages fail locally before the handshake is complete. A protocol-version mismatch closes the socket clearly. When a socket closes unexpectedly, pending requests fail, shared transport becomes disconnected, and the connection retries. Desired route subscriptions remain remembered and are replayed after the next successful handshake.

Request IDs and request/result correlation are application-wide responsibilities of `AppConnection`; they are not duplicated by instrument bindings.

## Route subscriptions

Each route controls only publication fanout:

```text
Scope route mount     -> ScopeBinding.activate()   -> subscribe DHO804
Scope route unmount   -> ScopeBinding.deactivate() -> unsubscribe DHO804

DMM route mount       -> DmmBinding.activate()     -> subscribe DM858E
DMM route unmount     -> DmmBinding.deactivate()   -> unsubscribe DM858E
```

These subscriptions do not own physical runtime lifetime. The server starts and maintains the configured DHO804 and DM858E runtimes independently of browser routes. Route changes, last unsubscribe, browser disconnect and browser reconnect do not start or stop physical runtimes.

## Scope binding

`ScopeBinding` owns the browser-side mapping between DHO804 protocol traffic and scope application/domain behavior. It currently owns:

- DHO804 lifecycle/state message handling;
- scope command request construction;
- measurement request/poll coordination;
- deep-capture request/result handling;
- DHO804 binary waveform decoding;
- waveform-controller session reset and deep-capture retirement;
- transport-loss invalidation of scope presentation;
- publication subscribe/unsubscribe.

Ordinary React components still call scope binding methods in Stream E. Moving optimistic command/error orchestration out of views into a dedicated scope action layer is Stream F; do not fold that work back into `AppConnection`.

## DMM binding

`DmmBinding` owns the browser-side mapping between DM858E protocol traffic and DMM domain state. It owns:

- DMM lifecycle/state/snapshot message handling;
- DMM command request construction;
- instrument-targeted DMM SCPI calls;
- transport-loss invalidation of DMM presentation;
- publication subscribe/unsubscribe.

The DMM store remains separate from scope state. DMM pending-control/error presentation remains DMM-specific; Stream F owns moving view-side control orchestration behind domain actions.

## Instrument stores

### DHO804

`scope-store.ts` owns scope/domain presentation state only:

- awaiting/connected/disconnected physical scope presentation;
- complete authoritative `ScopeState`;
- measurement selections/results;
- deep-capture lifecycle metadata;
- scope-specific UI error state.

It does not own WebSocket transport lifecycle.

### DM858E

`dmm-store.ts` owns DMM/domain presentation state only:

- awaiting/connected/disconnected physical DMM presentation;
- complete authoritative `DmmState`;
- latest primary reading;
- DMM control pending/error presentation.

It does not own WebSocket transport lifecycle.

Physical instrument state remains authoritative. Optimistic presentation may be used for interaction, but complete later server state wins.

## DHO804 waveform path

Waveform sample arrays stay outside React and Zustand:

```text
WebSocket binary frame
  -> AppConnection transport fanout
  -> ScopeBinding
  -> decodeWaveformFrame()
  -> WaveformController
  -> uPlot
```

`AppConnection` does not decode or interpret DHO804 waveform payloads. Scope-specific decoding, sequence handling, live/deep display state and malformed-frame policy stay in `ScopeBinding` / the waveform layer.

Create one uPlot instance for the mounted scope waveform view and update it imperatively. Use uPlot mode 2 so channels can carry independent X/Y arrays. Do not auto-range channel Y scales from waveform values.

DHO804 live samples remain latest-oriented and disposable. Deep-capture source data remains server-side; the browser retains metadata and display-sized viewport windows only.

## Scope interactions

Continuous scope interactions remain optimistic. During a drag, presentation updates locally and `InteractionUpdate` is sent without waiting for acknowledgement. At interaction end, `InteractionCommit` completes through normal request correlation and authoritative server state reconciles the result.

The server owns the browser-session lease for long-lived scope interactions. Browser route subscription is not a physical-runtime lease.

The waveform shell remains the interaction coordinate system for horizontal position, channel-offset markers and trigger-level markers. Established full-shell drag equations and clamped-marker behavior remain unchanged by Stream E.

## Measurements and deep capture

Scope measurements remain dynamic request/result data, not `ScopeState`. Only displayed scope measurements are polled, with overlapping measurement requests suppressed.

Deep capture remains an explicit scope operation:

- capture is retained server-side;
- browser receives capture metadata;
- browser requests display-sized viewports;
- `WaveformController` owns viewport cache/display behavior;
- Run/Single or authoritative resumed acquisition retires stale deep-capture presentation.

## Raw SCPI

Raw SCPI is explicitly instrument-targeted:

```text
AppConnection.executeScpi(instrument, command)
```

There is no implicit scope target. `AppConnection` owns request correlation only; server-side scope/DMM adapters own instrument dispatch.

## Presentation rules

Both routes combine shared transport state with instrument-domain state when deciding what to render. A stale prior reading or connected state must not look live after browser transport loss.

The shared instrument header continues to own application-level controls such as navigation and browser-local screenshot copying. Screenshot capture remains browser-local and adds no external package/service dependency.

## Performance rules

- keep one application WebSocket across route changes;
- keep WebSocket transport state in one application store;
- keep scope/DMM domain stores separate;
- keep waveform samples outside React/Zustand and outside generic transport semantics;
- reuse one uPlot instance while the scope view is mounted;
- keep continuous interactions optimistic;
- keep live/deep waveform caches bounded/latest-oriented;
- do not retain stale DMM or scope connected presentation after transport loss;
- do not add a generic instrument store, plugin layer or client-side event bus;
- measure before adding throttles or rendering machinery.
