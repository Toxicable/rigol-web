# Frontend Architecture

## Purpose

The browser serves two fixed instrument routes while keeping one application transport connection alive across navigation:

- `/` — DHO804 oscilloscope
- `/dm858e` — DM858E digital multimeter

The browser architecture is concrete rather than a generic instrument framework. Scope and DMM keep separate domain stores, bindings and action APIs.

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
  |     - DHO804 wire request/message mapping
  |     - lifecycle/state projection
  |     - waveform decode/controller handoff
  |     - scope publication subscription
  |       ^
  |       |
  |     ScopeActions
  |     - domain-valued scope commands
  |     - optimistic updates
  |     - interaction coalescing/commit
  |     - command error/pending ownership
  |     - measurement configuration/polling
  |
  `-> DmmBinding
        - DM858E wire request/message mapping
        - lifecycle/state/snapshot projection
        - DMM publication subscription
          ^
          |
        DmmActions
        - domain-valued DMM controls
        - redundant-write suppression
        - pending/error ownership
```

`App` constructs one `AppConnection`, `ScopeBinding`, `DmmBinding`, `ScopeActions` and `DmmActions` above the route elements. Route navigation does not recreate them. Route mount/unmount controls publication subscriptions only.

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

`Connected` means the WebSocket completed the application protocol handshake, not merely that the socket opened.

Scope and DMM stores do not duplicate WebSocket transport state. They represent physical instrument/domain presentation only. When shared transport leaves `Connected`, active bindings invalidate stale instrument presentation by returning their instrument store to its awaiting-instrument state.

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

Application messages fail locally before handshake completion. A protocol-version mismatch closes the socket clearly. Unexpected close rejects pending requests and schedules reconnect. Desired route subscriptions are replayed only after the next successful handshake.

Request IDs and request/result correlation are application-wide responsibilities of `AppConnection`; instrument bindings and actions do not duplicate them.

## Route subscriptions

Each route controls only publication fanout:

```text
Scope route mount     -> ScopeBinding.activate()   -> subscribe DHO804
Scope route unmount   -> ScopeBinding.deactivate() -> unsubscribe DHO804

DMM route mount       -> DmmBinding.activate()     -> subscribe DM858E
DMM route unmount     -> DmmBinding.deactivate()   -> unsubscribe DM858E
```

Scope route unmount also cancels any browser-side coalesced interaction update before unsubscribing, preventing an interaction update from being emitted after route exit.

These subscriptions do not own physical runtime lifetime. The server maintains the configured DHO804 and DM858E runtimes independently of browser routes, last unsubscribe, browser disconnect and browser reconnect.

## Domain actions

Ordinary React controls express instrument-domain intent, not WebSocket messages or protocol discriminants.

Examples:

```text
Channel scale input
  -> ScopeActions.setChannelScale(channel, value)
  -> optimistic scope presentation
  -> ScopeBinding.setControl(...)
  -> AppConnection request
  -> authoritative ScopeState later replaces optimistic state

DMM range button
  -> DmmActions.setRange(range)
  -> construct control from current authoritative DMM function
  -> DMM pending ownership
  -> DmmBinding.setDmmControl(...)
  -> authoritative DmmState later wins
```

`ScopeActions` owns ordinary scope command failure presentation, optimistic control updates, 50 ms latest-value interaction coalescing, final interaction commit, Sleep pending state, and scope measurement configuration/polling. `DmmActions` owns DMM control construction, redundant-write suppression, and generation-safe pending/error handling.

Scope and DMM actions remain separate. There is no generic dispatcher, reducer or cross-instrument command abstraction.

Local UI-only state stays in components where appropriate; for example DMM trend viewport state and measurement picker selections do not need an action layer.

## Scope binding

`ScopeBinding` maps DHO804 protocol traffic to scope domain behavior. It owns:

- DHO804 lifecycle/state message handling;
- wire request construction for scope controls/actions;
- deep-capture request/result wire mapping;
- DHO804 binary waveform decoding;
- waveform-controller session reset and deep-capture retirement;
- transport-loss invalidation of scope presentation;
- publication subscribe/unsubscribe.

It does not own ordinary measurement polling, optimistic control orchestration or React command error handling; those belong to `ScopeActions`.

## DMM binding

`DmmBinding` maps DM858E protocol traffic to DMM domain state. It owns:

- DMM lifecycle/state/snapshot message handling;
- DMM wire request construction;
- instrument-targeted DMM SCPI calls;
- transport-loss invalidation of DMM presentation;
- publication subscribe/unsubscribe.

The DMM store remains separate from scope state. DMM control pending/error orchestration belongs to `DmmActions`.

## Instrument stores

### DHO804

`scope-store.ts` owns scope/domain presentation state only:

- awaiting/connected/disconnected physical scope presentation;
- complete authoritative `ScopeState`;
- measurement selections/results;
- deep-capture lifecycle metadata;
- Sleep pending presentation;
- scope-specific UI error state.

It does not own WebSocket transport lifecycle.

### DM858E

`dmm-store.ts` owns DMM/domain presentation state only:

- awaiting/connected/disconnected physical DMM presentation;
- complete authoritative `DmmState`;
- latest primary reading;
- generation-safe DMM control pending/error presentation.

It does not own WebSocket transport lifecycle.

Physical instrument state remains authoritative. Actions may update presentation optimistically, but later complete server state replaces the authoritative instrument snapshot.

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

`AppConnection` does not decode DHO804 waveform payloads. Scope-specific decoding, sequence handling, live/deep display state and malformed-frame policy stay in `ScopeBinding` / the waveform layer.

The waveform view keeps pointer geometry and imperative rendering. It emits domain interaction intent to `ScopeActions`; it no longer constructs `InteractiveControl` wire values or owns interaction coalescing/error handling.

Create one uPlot instance for the mounted scope waveform view and update it imperatively. Use uPlot mode 2 so channels can carry independent X/Y arrays. Do not auto-range channel Y scales from waveform values.

DHO804 live samples remain latest-oriented and disposable. Deep-capture source data remains server-side; the browser retains metadata and display-sized viewport windows only.

## Scope interactions

Continuous scope interactions remain optimistic. During a drag, `ScopeActions` updates presentation immediately and emits the newest coalesced `InteractionUpdate` without waiting for acknowledgement. At interaction end it sends `InteractionCommit`; authoritative scope state later reconciles the result.

The server owns the browser-session lease for long-lived scope interactions. Browser route subscription is not a physical-runtime lease.

The waveform shell remains the interaction coordinate system for horizontal position, channel-offset markers and trigger-level markers. Existing full-shell drag equations and clamped-marker behavior remain unchanged.

## Measurements and deep capture

Scope measurements remain dynamic request/result data, not `ScopeState`. `ScopeActions` configures displayed measurements and suppresses overlapping polling requests.

Deep capture remains an explicit scope operation:

- capture is retained server-side;
- browser receives capture metadata;
- browser requests display-sized viewports;
- `WaveformController` owns viewport cache/display behavior;
- Run/Single or authoritative resumed acquisition retires stale deep-capture presentation.

## Raw SCPI

Raw SCPI is deliberately transport-oriented and explicitly instrument-targeted:

```text
AppConnection.executeScpi(instrument, command)
```

The raw SCPI console is the intentional exception to ordinary domain-action controls: it is a diagnostic protocol surface whose purpose is to send arbitrary SCPI to a selected instrument. There is no implicit scope target and no fake domain action wrapper around arbitrary SCPI.

## Presentation rules

Both routes combine shared transport state with instrument-domain state when deciding what to render. A stale prior reading or connected state must not look live after browser transport loss.

The shared instrument header continues to own application-level controls such as navigation and browser-local screenshot copying. Screenshot capture remains browser-local and adds no external package/service dependency.

## Performance rules

- keep one application WebSocket across route changes;
- keep WebSocket transport state in one application store;
- keep scope/DMM domain stores and action APIs separate;
- keep waveform samples outside React/Zustand and outside generic transport semantics;
- reuse one uPlot instance while the scope view is mounted;
- keep continuous interactions optimistic and latest-oriented;
- keep live/deep waveform caches bounded/latest-oriented;
- do not retain stale DMM or scope connected presentation after transport loss;
- do not add a generic instrument store, plugin layer, command dispatcher or client-side event bus;
- measure before adding throttles or rendering machinery.
