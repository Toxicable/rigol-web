# Frontend Architecture

## Purpose

The browser serves three fixed instrument routes while keeping one application WebSocket alive across navigation:

- `/` — DHO804 oscilloscope
- `/dm858e` — DM858E digital multimeter
- `/ppk2` — Nordic PPK2

The browser is concrete rather than a generic instrument framework. Scope, DMM and PPK2 keep separate domain stores, bindings and action APIs.

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
  +-> ScopeBinding -> ScopeActions -> scope UI
  +-> DmmBinding   -> DmmActions   -> DMM UI
  `-> Ppk2Binding  -> Ppk2Actions  -> PPK2 UI
```

`App` constructs one `AppConnection` and one binding/action pair for each instrument above the route elements. Route navigation does not recreate them. Route mount/unmount controls publication subscriptions only.

## Shared transport state

`src/web/app-transport-store.ts` is the single owner of browser/server transport state:

```ts
export enum AppTransportKind {
  Connecting = 1,
  Connected = 2,
  Disconnected = 3,
}
```

`Connected` means the application protocol handshake completed, not merely that a socket opened.

Instrument stores do not duplicate WebSocket transport state. Active bindings invalidate stale connected presentation when shared transport leaves `Connected`.

Transport and physical instrument lifecycle remain separate questions:

- transport: can this browser communicate with Rigol Web?
- instrument: is this physical instrument connected and usable?

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

Application messages fail locally before handshake completion. Unexpected close rejects pending requests and schedules reconnect. Desired route subscriptions are replayed only after the next successful handshake.

Request IDs/correlation remain application-wide responsibilities of `AppConnection`.

## Route subscriptions

Each route controls publication fanout only:

```text
Scope mount   -> ScopeBinding.activate() -> subscribe DHO804
DMM mount     -> DmmBinding.activate()   -> subscribe DM858E
PPK2 mount    -> Ppk2Binding.activate()  -> subscribe PPK2
```

Unmount performs the matching unsubscribe.

Subscriptions do not own physical runtime lifetime. The server keeps all three configured runtimes alive independently of browser routes.

A running PPK2 capture also survives PPK2 route unmount/unsubscribe. When the route remounts, the adapter replays current PPK2 lifecycle and capture stats.

## Domain actions

Ordinary React controls express instrument-domain intent, not WebSocket message discriminants.

`ScopeActions` owns scope command orchestration, optimistic presentation, coalesced continuous interaction, command errors, Sleep pending state and measurement polling.

`DmmActions` owns DMM control construction, redundant-write suppression, and generation-safe pending/error handling.

`Ppk2Actions` owns:

- capture start intent;
- capture stop intent using the current operation ID;
- retained-history viewport intent;
- duplicate/pending request suppression;
- PPK2 request error presentation.

The PPK2 route calls these actions and does not construct PPK2 WebSocket requests itself.

## Scope binding/store

`ScopeBinding` maps DHO804 protocol traffic, lifecycle/state and binary waveform data. `scope-store.ts` owns scope presentation only.

Waveform sample arrays stay outside React and Zustand:

```text
WebSocket binary frame
 -> AppConnection
 -> ScopeBinding
 -> WaveformController
 -> uPlot
```

DHO804 live data remains disposable/latest-oriented.

## DMM binding/store

`DmmBinding` maps DM858E lifecycle/state/snapshot traffic and typed DMM requests. `dmm-store.ts` owns DMM presentation only.

Latest DMM snapshot state is display state, not a uniquely identified logging sample stream.

## PPK2 binding/store

`Ppk2Binding` maps PPK2 protocol traffic to the PPK2 browser domain. It owns:

- PPK2 publication subscribe/unsubscribe;
- connected/disconnected projection;
- capture-stat projection;
- decimated-live projection;
- capture start/stop wire requests;
- retained viewport request/result mapping;
- transport-loss invalidation of PPK2 connected presentation.

`ppk2-store.ts` owns only browser-appropriate state:

- awaiting/connected/disconnected PPK2 presentation;
- latest `Ppk2CaptureStats`;
- decimated live buckets;
- one explicitly requested retained viewport;
- PPK2 request pending/error state.

It does **not** store raw PPK2 samples.

## PPK2 display bounds

The server live stream is already decimated before reaching the browser.

Current server reduction:

- 100 raw samples per live bucket = 1 ms at 100 kSa/s;
- 20 buckets per normal live publication = about 20 ms.

The browser keeps at most 5,000 live buckets, about five seconds at this bucket width. Adding new live buckets beyond the cap discards the oldest browser display summaries only.

A retained-history request asks the server for an explicitly reduced viewport. The current action requests up to 1,200 buckets for the known acquisition sequence range; raw retained arrays remain server-side.

When a retained viewport is displayed, the next live publication returns the route to live display by clearing the retained viewport.

## PPK2 route presentation

The PPK2 route presents:

- physical/transport status;
- PPK2 source session/hardware metadata;
- Start Capture / Stop Capture;
- Load retained history;
- current trace envelope plus mean line from decimated buckets;
- received/lost/retained sample information;
- latest/min/max/mean/RMS current;
- integrated charge;
- fixed 100 kSa/s / Ampere Meter context.

Formatting is PPK2-local rather than pretending PPK2 uses oscilloscope channel units.

## Backpressure semantics

A slow browser may miss **decimated PPK2 live display updates** when its WebSocket is backpressured. Those are presentation summaries and are not the acquisition data source.

The server continues raw PPK2 decoding, sequence/loss accounting, statistics, charge integration and bounded storage independently. A later retained viewport can reconstruct display history from the server-retained raw capture window.

This is deliberately different from silently dropping raw source samples.

## Raw SCPI

Raw SCPI remains explicitly instrument-targeted for the two SCPI instruments:

```text
AppConnection.executeScpi(instrument, command)
```

PPK2 does not expose raw SCPI because it is not a SCPI device.

## Presentation/performance rules

- keep one application WebSocket across route changes;
- keep WebSocket transport state in one application store;
- keep scope/DMM/PPK2 domain stores and action APIs separate;
- keep DHO804 waveform arrays outside React/Zustand;
- keep PPK2 raw samples entirely server-side;
- bound PPK2 decimated browser history;
- allow display-only PPK2 live summaries to be dropped under browser backpressure without affecting raw acquisition;
- do not retain stale instrument connected presentation after transport loss;
- do not add a generic instrument store, plugin layer, command dispatcher or client-side event bus.
