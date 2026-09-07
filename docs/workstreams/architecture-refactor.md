# Usage-driven architecture refactor workstreams

## Purpose

This document turns the 2026-09-07 usage-driven architecture review into implementation streams that can be handed to an LLM one stream at a time.

Source review:

- `docs/changes/2026-09-07-usage-driven-architecture-review.md`

The refactor is not a rewrite and must not create a generic instrument framework. The working lower layers stay intact: SCPI transport/scheduler, concrete instrument drivers, authoritative instrument state, DHO waveform handling, and separate instrument domain models.

The goal is to change the application's unit of ownership from **mounted instrument route** to **server-owned instrument service**, then give acquisition/recording an explicit server-side lifetime before adding PPK2.

Incremental software/package cost for all streams: **A$0**.

## Rules for every implementation agent

Before changing code:

1. read `/AGENTS.md`;
2. read this file;
3. read `docs/architecture.md`, `docs/server-architecture.md`, and `docs/frontend.md` as relevant to the stream;
4. read the source files named in the selected stream;
5. inspect adjacent tests before changing interfaces.

Implementation rules:

- hard cuts only; update all owned callers directly;
- do not add compatibility aliases, dual APIs, feature flags, generic plugin systems, DI frameworks, or a global event bus;
- keep instrument-specific domain types separate;
- do not make DHO804, DM858E, and PPK2 pretend to have identical capabilities;
- `ScpiTransport`, `ScpiScheduler`, `Dho804Driver`, and `Dm858eDriver` are not refactor targets unless a stream explicitly requires a minimal caller-facing change;
- keep waveform/sample arrays out of React/Zustand;
- update architecture docs when a stream changes an active architectural rule;
- add/update tests for the new boundary before declaring the stream complete;
- run `pnpm typecheck`, `pnpm test`, and `pnpm build` before completion.

An implementation agent should complete exactly one stream unless explicitly told to continue.

## Order

```text
A. Server application-service boundary
        |
        v
B. Scope power/lifecycle ownership
        |
        v
C. WebSocket broker + instrument adapters
        |
        v
D. Server-owned runtime lifetime + publication subscriptions
        |
        v
E. Browser transport + instrument bindings
        |
        v
F. Browser domain actions
        |
        v
G. Acquisition operation model
        |
        v
H. PPK2 integration
```

These streams are deliberately mostly sequential. Each one changes ownership assumptions consumed by the next. Do not introduce temporary compatibility layers just to allow later streams to start early.

---

# Stream A — Server application-service boundary

## Goal

Create explicit scope and DMM application-service boundaries and straighten dependency direction so runtime/domain code no longer depends on WebSocket gateway types.

After this stream, the server should have a clear distinction:

```text
application service/controller
        |
      runtime
        |
      driver
        |
 scheduler/transport
```

The service/controller owns application semantics. Runtime owns physical session composition/lifecycle. Driver owns exact device protocol semantics.

## Read before changing code

- `src/server/server.ts`
- `src/server/scope-runtime.ts`
- `src/server/scope/scope-controller.ts`
- `src/server/dmm/dmm-runtime.ts`
- `src/server/websocket/websocket-gateway.ts`
- `src/server/instruments/instrument-registry.ts`
- relevant shared domain types

## Owns

- explicit scope application-service/controller surface;
- explicit DMM application-service/controller surface;
- data-only runtime status/connection types outside the WebSocket layer;
- removal of imports from runtime/domain code into `websocket-gateway.ts`;
- removal of WebSocket protocol result types from runtime APIs where domain result types are sufficient;
- normalization of the meaning of `Runtime` across scope and DMM.

## Required result

The gateway should be able to depend on scope/DMM application services, but scope/DMM runtime code must not import the gateway.

Prefer concrete service surfaces, for example conceptually:

```text
ScopeService
  current status/state
  controls
  acquisition actions
  measurements
  raw SCPI
  waveform/deep-capture operations

DmmService
  current status/state
  controls
  current display snapshot
  raw SCPI
```

Exact class/interface names are implementation choices. Do not force both services into one generic `InstrumentService` interface.

## Non-goals

- do not split `WebSocketGateway` yet;
- do not change browser route/runtime lifetime yet;
- do not redesign SCPI scheduling;
- do not add PPK2 abstractions;
- do not add a generic event bus.

## Acceptance criteria

- no scope/DMM runtime or domain file imports WebSocket gateway connection types;
- no runtime API needs a wire-protocol type where a domain type can represent the result;
- scope and DMM expose explicit application-level entry points to the gateway/composition root;
- `Runtime` has a consistent physical-session/composition meaning;
- existing scope/DMM behavior remains unchanged;
- tests cover the service/runtime boundary.

---

# Stream B — Scope power/lifecycle ownership

## Depends on

Stream A complete.

## Goal

Move DHO804 sleep/wake orchestration out of HTTP/server composition code and behind the scope application service/runtime.

Scope power is an instrument application operation, not a second server control plane.

## Read before changing code

- scope service/runtime produced by Stream A;
- `src/server/server.ts`;
- `src/server/http-handler.ts`;
- ADB/scope power helper code;
- physical-wake/TCP monitoring code;
- browser toolbar/client code that invokes scope Sleep.

## Owns

- scope suspend/sleep/wake-monitor/resume orchestration;
- scope service method for Sleep;
- WebSocket protocol request/response for Sleep;
- removal of `POST /api/scope/sleep`;
- reduction of `server.ts` to composition/startup/shutdown responsibilities.

## Required result

The path becomes:

```text
browser scope action
 -> WebSocket scope request
 -> ScopeService.sleep()
 -> runtime/power helper orchestration
```

HTTP should remain for frontend/static serving, health, and genuinely HTTP-specific infrastructure.

## Non-goals

- do not change the chosen ADB/TCP wake mechanism unless required to move ownership;
- do not redesign instrument runtime lifetime yet;
- do not add generic power-management abstractions for all instruments.

## Acceptance criteria

- no scope power/sleep orchestration remains in `server.ts`;
- `/api/scope/sleep` no longer exists;
- Sleep uses the normal application/WebSocket command path;
- scope power lifecycle has one owning service/runtime boundary;
- sleep/wake behavior remains functionally equivalent;
- tests cover successful sleep, failure cleanup, and wake/resume orchestration.

---

# Stream C — WebSocket broker + explicit instrument adapters

## Depends on

Streams A and B complete.

## Goal

Split `WebSocketGateway` so the common WebSocket layer owns transport/session concerns and explicit scope/DMM adapters own instrument request/publication mapping.

This stream fixes application layering; it is not merely a file-size cleanup.

## Read before changing code

- `src/server/websocket/websocket-gateway.ts`;
- shared WebSocket protocol definitions;
- scope/DMM services from Stream A;
- waveform binary protocol/encoding;
- WebSocket tests.

## Target shape

```text
WebSocket server
  -> session/protocol broker
      -> Scope adapter -> ScopeService
      -> DMM adapter   -> DmmService
```

The broker owns:

- socket accept/close;
- protocol hello/version handshake;
- browser session identity;
- request correlation/common command-result framing;
- desired publication subscriptions;
- common wire decode/encode;
- common transport/backpressure limits.

The scope adapter owns:

- scope request validation/dispatch;
- scope lifecycle/state projection;
- scope measurements/raw SCPI mapping;
- scope waveform/deep-capture wire mapping;
- scope-specific live waveform replacement/backpressure semantics.

The DMM adapter owns:

- DMM request validation/dispatch;
- DMM lifecycle/state/snapshot projection;
- DMM raw SCPI mapping.

## Owns

- decomposition of `WebSocketGateway`;
- explicit adapter interfaces/classes;
- removal of instrument application semantics from the common broker;
- cleanup of server composition wiring after the split.

## Non-goals

- do not create a generic plugin registry;
- do not create a generic `InstrumentAdapter` API unless a genuinely tiny transport-only contract naturally exists;
- do not change physical runtime activation policy yet;
- do not redesign browser transport yet.

## Acceptance criteria

- common broker contains no DHO804/DM858E command semantics;
- scope and DMM request routing are isolated in explicit adapters;
- replacing WebSocket delivery would not require changing scope/DMM application services;
- waveform binary handling remains scope-specific;
- existing protocol behavior remains compatible only with the current source version; no compatibility shim is introduced;
- tests cover broker handshake/session behavior independently of instrument adapters and adapter dispatch independently of real sockets where practical.

---

# Stream D — Server-owned runtime lifetime and publication subscriptions

## Depends on

Stream C complete.

## Goal

Decouple physical instrument runtime lifetime from browser route/subscription lifetime.

Browser subscriptions become publication/fanout concerns only. They must no longer decide whether a physical runtime exists.

## Read before changing code

- `src/server/instruments/instrument-registry.ts`;
- scope/DMM runtimes and services;
- WebSocket session/subscription broker from Stream C;
- route subscription protocol and tests;
- server startup/shutdown composition.

## Required lifetime model

Use one deterministic model for the known bench instruments:

- server owns scope and DMM runtime/session lifetime;
- server startup activates/maintains the known configured instrument services;
- browser subscribe/unsubscribe only controls what is published to that browser session;
- browser disconnect does not stop a physical runtime;
- server shutdown stops all runtimes;
- an instrument transport failure may reconnect according to its existing runtime recovery semantics without requiring a browser subscriber to exist.

Do not introduce runtime-lifetime feature flags or configurable policies.

## Owns

- replacement/removal of subscriber-count-driven activation;
- removal of `Set<object>` browser subscribers from physical lifecycle ownership;
- removal of runtime `subscriberAdded()` browser-awareness;
- current-state/current-snapshot replay at the WebSocket adapter/session boundary;
- server startup/shutdown runtime ownership;
- documentation of the new deterministic lifetime policy.

## Multi-browser semantic rule

Make this explicit while touching session ownership:

- atomic instrument controls are global and last accepted write wins;
- long-lived operations/interactions must have explicit ownership/operation identity where needed;
- browser subscription itself is never an ownership lease for the physical runtime.

Do not build collaborative locking infrastructure in this stream.

## Non-goals

- do not implement acquisition sessions yet;
- do not add persistence;
- do not create a generic plugin manager.

## Acceptance criteria

- navigating away from a route does not close the corresponding physical instrument session;
- closing the last browser tab does not stop scope/DMM runtimes;
- a newly subscribed browser receives current lifecycle/state/snapshot without notifying the physical runtime that a subscriber appeared;
- physical runtime lifecycle is owned by server startup/shutdown/recovery, not browser subscriber counts;
- tests explicitly cover route unsubscribe and last-client disconnect without runtime stop.

---

# Stream E — Browser transport and instrument bindings

## Depends on

Stream D complete.

## Goal

Replace the scope-shaped global WebSocket client with an application connection/request broker plus explicit scope and DMM bindings.

Centralize browser transport state so each instrument store does not reimplement WebSocket connection lifecycle.

## Read before changing code

- `src/web/websocket-client.ts`;
- `src/web/app.tsx`;
- `src/web/scope-route-binding.ts`;
- `src/web/dmm/dmm-route-binding.ts`;
- `src/web/scope-store.ts`;
- `src/web/dmm/dmm-store.ts`;
- waveform controller/decoder code;
- frontend architecture docs and tests.

## Target shape

```text
AppConnection
  -> handshake
  -> reconnect
  -> request IDs/deadlines
  -> request/response correlation
  -> publication subscriptions
  -> app transport state

ScopeBinding
  -> scope lifecycle/state/messages
  -> scope waveform binary path
  -> scope store/controller

DmmBinding
  -> DMM lifecycle/state/snapshot messages
  -> DMM store
```

The base app connection must not mutate scope or DMM Zustand state directly.

## Owns

- hard rename/replacement of `ScopeWebSocketClient` as the app-wide transport/request broker;
- extraction of scope-specific message handling;
- extraction of DMM-specific message handling;
- one application transport store/state owner;
- removal of duplicated transport lifecycle from scope/DMM instrument stores;
- route bindings that control publication subscriptions only.

## Non-goals

- do not move all UI controls into actions yet; that is Stream F;
- do not put waveform samples in Zustand;
- do not make a generic mixed instrument store;
- do not add PPK2 yet.

## Acceptance criteria

- no class named/structured as a scope client owns app-global connection concerns;
- app transport state has one owner;
- scope/DMM stores represent instrument/domain state rather than WebSocket transport state;
- scope binary waveform handling remains outside React/Zustand and outside the generic app connection;
- route navigation changes publication subscriptions without recreating the app connection;
- tests cover reconnect/handshake independently of scope/DMM domain stores.

---

# Stream F — Browser domain actions

## Depends on

Stream E complete.

## Goal

Stop React view components from constructing wire-protocol commands, directly coordinating optimistic store updates, and handling transport errors.

Views should express domain intent through scope/DMM action layers.

## Read before changing code

- scope controls/components;
- DMM controls/components and existing `applyDmmControl()`;
- scope/DMM stores;
- ScopeBinding/DmmBinding/AppConnection from Stream E;
- frontend tests.

## Target shape

```text
React component
  -> scopeActions.setChannelScale(channel, value)
      -> optimistic presentation/store update
      -> ScopeBinding/AppConnection request
      -> authoritative state reconciliation

React component
  -> dmmActions.setRange(...)
      -> pending/error ownership
      -> DmmBinding/AppConnection request
      -> authoritative state reconciliation
```

## Owns

- explicit scope action layer;
- explicit DMM action layer;
- optimistic-control ownership outside presentational components;
- command failure/pending ownership outside presentational components;
- removal of WebSocket protocol imports from ordinary control components;
- removal of direct app-connection dependencies from ordinary control components where domain actions suffice.

## Non-goals

- do not hide ordinary local UI state behind actions;
- do not create Redux-style generic dispatch/reducer infrastructure;
- do not merge scope and DMM action APIs;
- waveform imperative rendering remains separate.

## Acceptance criteria

- ordinary scope/DMM control components deal in domain values/callbacks, not wire messages;
- optimistic updates and command errors have one owner per instrument domain;
- React components do not need to know WebSocket request discriminants;
- authoritative server state still wins after optimistic interaction;
- tests exercise actions directly without rendering a complete route where practical.

---

# Stream G — Server-owned acquisition operation model

## Depends on

Streams A-D complete. Prefer E-F complete before adding browser UI for the model.

## Goal

Introduce acquisition/recording as an explicit server-side application operation with a lifetime independent of the current browser route.

This stream creates the ownership/storage contract needed by PPK2. It must not prematurely force scope, DMM, and PPK2 into one generic sample format.

## Read before changing code

- DHO live/deep waveform services;
- DMM latest snapshot/trend implementation;
- scope/DMM services;
- WebSocket broker/adapters;
- `docs/waveforms.md` and waveform protocol docs;
- Toxicboards PPK2Wireless project documentation before finalizing PPK2-facing requirements.

## Required concepts

Define explicit domain concepts for long-lived server-owned operations, including as applicable:

- operation/acquisition ID;
- owner/initiator metadata where needed;
- start timestamp;
- running/stopped/failed state;
- explicit stop;
- sample/event sequence or loss accounting for streaming sources;
- bounded in-memory storage contract;
- range/viewport reads;
- statistics attachment/update boundary;
- export boundary;
- lifecycle independent of browser route rendering.

The first implementation can be minimal and concrete. Factor shared storage/export code only when actual overlap is present.

## Semantic rules

- browser navigation never implicitly stops a server-owned acquisition;
- browser disconnect does not implicitly stop an acquisition unless the operation was explicitly defined as session-owned;
- DHO disposable live display frames remain disposable and are not automatically recordings;
- DHO retained deep capture may remain its existing concrete representation unless integrating it with the operation model provides a clear benefit;
- DMM latest display snapshots are not unique physical samples and must not be promoted into a logging stream without verified sample identity/semantics;
- streaming sources that require loss detection must preserve sequence/loss information; they must not use DHO "latest frame wins" semantics for raw acquisition.

## Owns

- acquisition operation domain types/services;
- bounded server storage interface/implementation sufficient for upcoming PPK2 work;
- operation lifecycle API exposed through the application service/WebSocket adapter layers;
- tests for operation survival across browser unsubscribe/disconnect;
- documentation of retention/bounds and ownership semantics.

## Non-goals

- do not implement PPK2 transport/decoder yet;
- do not invent one universal numeric sample structure;
- do not convert DMM display trend into fake data logging;
- do not add database infrastructure unless a concrete requirement from PPK2 storage makes it necessary.

## Acceptance criteria

- a server-owned acquisition can exist without a mounted route;
- operation lifetime and browser publication lifetime are separate;
- bounded storage behavior is explicit and tested;
- streaming operation contracts can report sequence/loss;
- no existing scope waveform path is degraded merely to fit the new abstraction;
- the contract is sufficient for Stream H to implement PPK2 without bypassing the application layers.

---

# Stream H — PPK2 integration

## Depends on

Streams A-G complete.

## Goal

Add PPK2 as the first non-SCPI streaming instrument using the new architecture rather than extending scope/DMM-specific shortcuts.

## Read before changing code

RigolWeb:

- all architecture-refactor outputs from Streams A-G;
- current WebSocket protocol/domain docs;
- acquisition operation/storage implementation;
- frontend binding/action patterns.

Toxicboards:

- root `AGENTS.md`;
- `projects/PPK2Wireless/PROJECT.yaml`;
- current PPK2Wireless board/project documentation and protocol decisions.

## Required server path

```text
PPK2 bridge TCP stream
  -> Ppk2Runtime
  -> PPK2 protocol decoder / calibration
  -> Ppk2Service
  -> acquisition store
  -> statistics + charge integration
  -> decimated live/viewport publications
  -> PPK2 WebSocket adapter
```

PPK2 must not use `ScpiScheduler`.

Raw acquisition data must not use the DHO live-waveform stale-frame replacement semantics. If bytes/samples are lost, the system must be able to detect and report the loss.

## Owns

- explicit PPK2 supported-instrument/domain types;
- PPK2 runtime TCP/session lifecycle;
- bridge protocol decoding;
- calibration/metadata handling owned by RigolWeb according to the Toxicboards project contract;
- sequence/loss accounting;
- server-side bounded acquisition storage;
- statistics and charge integration;
- display-decimated/live and history/viewport publication;
- PPK2 browser binding/store/actions/UI;
- protocol documentation and tests.

## Non-goals

- do not make PPK2 pretend to be SCPI;
- do not make all instruments implement a common capability set;
- do not put raw sample arrays in Zustand;
- do not discard raw samples silently to keep the graph current;
- do not redesign the PPK2 bridge hardware/firmware contract unless a concrete integration blocker is found and documented back in Toxicboards.

## Acceptance criteria

- PPK2 uses its own explicit runtime/service/adapter path;
- continuous acquisition survives navigation away from the PPK2 route;
- raw stream loss is detectable/accounted for;
- bounded acquisition storage cannot grow without limit;
- charge/statistics are derived server-side from the acquisition stream;
- browser receives display-appropriate decimated data rather than the full raw stream by default;
- app-wide transport remains generic while PPK2 domain behavior stays PPK2-specific;
- relevant integration decisions are documented in both RigolWeb and Toxicboards where the hardware/software contract is affected.

---

# Completion state

The architecture refactor is complete when Stream H lands and the active architecture documents describe this shape:

```text
Browser
  |
AppConnection
  |
  +-- ScopeBinding/actions/UI
  +-- DmmBinding/actions/UI
  `-- Ppk2Binding/actions/UI

WebSocket session/protocol broker
  |
  +-- Scope adapter -> ScopeService -> ScopeRuntime -> DHO804 driver -> SCPI
  +-- DMM adapter   -> DmmService   -> DmmRuntime   -> DM858E driver -> SCPI
  `-- PPK2 adapter  -> Ppk2Service  -> Ppk2Runtime  -> TCP stream
                          |
                    acquisition store
```

Physical instrument/runtime lifetime is server-owned. Browser subscriptions control publication only. Long-lived acquisition lifetime is explicit. Presentation components express domain intent rather than wire protocol messages.
