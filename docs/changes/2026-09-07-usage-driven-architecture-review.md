# Usage-driven architecture review

Date: 2026-09-07

This is a second-pass review focused on architectural shape after real application use, not bug hunting. It deliberately preserves the parts that are working well and identifies assumptions that made sense for the original scope-only UI but no longer fit a multi-instrument bench application.

## Main conclusion

RigolWeb should not be rewritten and should not become a generic instrument framework.

The DHO804/DM858E device layers are mostly sound. The architectural debt is above them: browser routes currently own instrument activation, application semantics leak into the WebSocket gateway, runtime/domain code depends upward on WebSocket types, and frontend views talk directly to the transport/protocol.

The top-level architectural unit should become a **server-owned instrument service**, not an **instrument route**.

## 1. Route lifetime should not own physical instrument lifetime

Current design:

```text
route mount
  -> browser subscription
  -> WebSocket session subscription
  -> InstrumentRegistry subscriber count
  -> physical runtime start

route unmount
  -> unsubscribe
  -> last subscriber disappears
  -> physical runtime stop
```

That coupling was economical for the first scope UI. It becomes wrong once the application owns acquisition history, logging, PPK2 streaming, background recording, cross-instrument views, or any operation expected to survive navigation.

Navigation is a presentation concern. It should decide what data the browser receives, not whether the server is connected to a physical instrument.

Recommended direction:

- server owns instrument runtime/session lifetime;
- browser subscriptions control publication/fanout;
- explicit acquisition/control operations own any temporary high-rate work;
- a recording or capture continues across route changes until explicitly stopped;
- browser disconnect does not implicitly cancel server-owned acquisition unless that operation was explicitly session-owned.

Do not add a generic runtime policy/configuration system. Pick one deterministic lifetime model for the known instruments.

## 2. `InstrumentRegistry` is coupled to browser delivery rather than instrument ownership

`InstrumentRegistry` tracks `Set<object>` subscribers and calls optional `runtime.subscriberAdded()` hooks. This means the low-level lifecycle abstraction knows that consumers are browser-like subscribers.

The DMM `subscriberAdded()` implementation then republishes the current reading through a callback so a newly subscribed browser receives it. That replay concern belongs at the presentation/session boundary, not in physical-runtime lifecycle.

Recommended direction:

- registry/manager owns known runtimes and their lifecycle;
- WebSocket session manager owns which clients subscribe to which instrument publications;
- each instrument service exposes current presentation snapshot/state plus explicit event/data subscriptions;
- new-client replay is produced from that current snapshot without notifying the physical runtime that a browser appeared.

## 3. `WebSocketGateway` has become the application layer

The gateway currently owns much more than WebSocket transport:

- wire parsing and validation;
- handshake;
- browser session lifecycle;
- instrument subscriptions;
- scope command dispatch;
- DMM command dispatch;
- scope state-store subscription;
- DMM lifecycle/state projection;
- raw SCPI routing;
- deep-view request generation/supersession;
- waveform binary validation;
- browser backpressure policy.

The result is not merely a large file. It means application semantics have no stable boundary independent of WebSocket delivery.

Recommended direction:

```text
WebSocket server
  -> protocol/session broker
      -> Scope application service adapter
      -> DMM application service adapter
      -> PPK2 application service adapter
```

Keep one physical WebSocket per browser. Do not add a generic event bus, DI framework or plugin system.

The central broker should own only:

- handshake;
- request correlation/session identity;
- subscriptions;
- wire decode/encode;
- common transport backpressure limits.

Instrument adapters own the mapping between wire requests and instrument application services.

## 4. Runtime/domain dependency direction is currently inverted

`ScopeRuntime` and `DmmRuntime` import connection types from `websocket-gateway.ts`. `ScopeRuntime` also uses WebSocket protocol result types for deep capture.

The current scope connection object is especially revealing: a "connection state" includes `ScopeStateStore` and `ScopeController` object references, while DMM instead passes separate handler callbacks. There is no single application-service boundary.

Recommended direction:

- runtime/device layer imports no WebSocket types;
- connection/status objects are data-only;
- scope application service exposes typed methods and state/event access;
- DMM application service exposes the same kind of boundary, without forcing their domain models to become identical;
- gateway adapters translate domain results into wire messages.

This also removes the `server.ts` `let gateway!` circular initialization pattern. `server.ts` should be a composition root, not a lifecycle coordinator.

## 5. `Runtime` currently means different things for scope and DMM

`ScopeRuntime` mostly composes physical session lifecycle, controller, poller and waveform services.

`DmmRuntime` owns lifecycle **and** logical mutation serialization/application control/readback behavior that is conceptually analogous to `ScopeController`.

This asymmetry is evidence that the application-service boundary was added differently for the second instrument.

Recommended direction:

```text
ScopeService / ScopeController
DmmService / DmmController
Ppk2Service
        |
      Runtime
        |
      Driver
```

Exact class names do not matter. The important distinction is:

- service/controller = application semantics;
- runtime = physical connection/session ownership/composition;
- driver = exact device protocol semantics.

## 6. Scope power/sleep is a second application control plane

Most physical instrument actions use the WebSocket command path. DHO804 Sleep instead uses `POST /api/scope/sleep`, then `server.ts` directly coordinates registry suspension, ADB power control and a TCP physical-wake monitor.

That fractures ownership of the scope lifecycle across the HTTP handler, composition root, registry, scope runtime and ADB helper.

Recommended direction:

- scope power/sleep is a scope application-service operation;
- scope service/runtime owns suspend/sleep/wake-monitor/resume orchestration;
- WebSocket scope adapter exposes it like other scope actions;
- HTTP remains static assets, health and genuinely HTTP-specific infrastructure.

## 7. Frontend views talk directly to transport/protocol

Current scope components import `ScopeWebSocketClient`, construct `ControlChange` protocol objects, mutate Zustand optimistically, issue transport calls and surface request errors.

The DMM path has already evolved a slightly different pattern (`applyDmmControl` at route level), showing the lack of one browser application-action boundary.

Recommended direction:

```text
React view
  -> scope actions/hooks
      -> scope store + app transport client

React view
  -> DMM actions/hooks
      -> DMM store + app transport client
```

Views should deal in domain intent such as `setChannelScale(channel, value)`, not WebSocket protocol messages.

The persistent connection should be renamed/reframed from `ScopeWebSocketClient` to an application transport/request broker. Scope waveform support remains an explicit scope binding rather than contaminating the base transport.

## 8. Transport state should have one browser owner

The WebSocket client already has application-level transport state, but scope and DMM stores each also represent transport connecting/disconnected states.

That forces each new instrument to repeat app-transport lifecycle logic.

Recommended direction:

- one app connection store/state owns WebSocket connecting/connected/disconnected;
- instrument stores own physical instrument lifecycle and domain state only;
- views combine app connection + instrument state when deciding presentation.

Keep instrument stores separate; do not create one generic mixed instrument Zustand object.

## 9. Multi-browser control semantics are currently accidental

Multiple browser tabs may share and mutate one physical instrument. SCPI transaction serialization makes bytes safe, but it does not define semantic ownership of long-lived interactions.

The waveform pause/interaction behavior is one visible symptom: an interaction begun by one client can affect global behavior and another client can commit/resume it.

Before adding more session-like operations, choose explicit semantics.

For a personal bench application the simplest deterministic model is preferable. Viable choices are:

- single controlling client per instrument, other clients observe; or
- all clients may issue atomic commands, but long-lived interaction/acquisition ownership is represented by explicit operation IDs/leases.

Do not leave this implicit.

## 10. Acquisition needs to become a server application concept

Current acquisition/history concepts are fragmented:

- DHO deep capture is retained server-side;
- live scope waveforms are disposable display frames;
- DMM trend is browser-component history of latest snapshots;
- no durable acquisition/session object exists;
- no application-wide recording/export model exists.

The PPK2 plan makes this architectural gap immediate. PPK2 is a continuous high-rate source where sample loss must be detectable and statistics/charge/storage belong in RigolWeb.

Recommended direction for PPK2:

```text
PPK2 bridge TCP stream
  -> Ppk2Runtime
  -> decoder/calibration
  -> acquisition store (bounded RAM and/or explicit recording persistence)
  -> statistics / charge integration
  -> decimated live/viewport publications
  -> browser
```

Raw PPK2 samples must not use DHO live-frame "latest frame wins" semantics and must not be placed in Zustand.

The acquisition operation must survive browser rendering and navigation independently.

Do not prematurely create one generic sample format for DHO, DM858E and PPK2. First make acquisition ownership/lifetime a first-class application concept; factor shared storage/export pieces only where real overlap exists.

## What should remain unchanged

Keep these boundaries:

- `ScpiTransport`: raw TCP/framing only;
- `ScpiScheduler`: serialized/prioritized access to one SCPI session;
- concrete `Dho804Driver` and `Dm858eDriver` device semantics;
- independent per-instrument physical sessions;
- complete authoritative physical state/readback model;
- DHO waveform sample arrays outside React/Zustand;
- server-side deep capture and viewport reduction;
- one persistent browser WebSocket;
- separate instrument domain stores/types.

Do not introduce microservices, a generic instrument plugin API, a global generic event bus, or an abstract "all instruments are the same" domain model.

## Refactor order

1. Define explicit scope and DMM application-service interfaces using domain types only.
2. Move scope power/sleep/wake lifecycle behind the scope service/runtime.
3. Make runtimes independent of WebSocket gateway/protocol types.
4. Split WebSocket gateway into common session/protocol broker plus scope/DMM adapters.
5. Remove browser-subscriber awareness from instrument runtime lifecycle/replay.
6. Decouple physical runtime lifetime from route subscription lifetime.
7. Replace `ScopeWebSocketClient` with app transport/request broker plus scope/DMM bindings/actions.
8. Move view-side command/store/error orchestration into domain action layers.
9. Define explicit acquisition/session ownership and server-side storage boundary.
10. Add PPK2 as the first non-SCPI streaming instrument through that architecture.

The purpose of this refactor is not abstraction for its own sake. It is to make the application's actual boundaries match its current role: a persistent bench application controlling several physical instruments, rather than two independent instrument pages sharing a socket.

Incremental software/package cost: **A$0**.
