# DM858E Implementation Workstreams

## Purpose

Break the DM858E addition into implementation streams with explicit dependencies and low file overlap.

The DM858E work does not replace the existing DHO804 architecture. It extends Rigol Web to two explicitly supported instruments while keeping shared SCPI infrastructure generic and device domains separate.

No logging is included in this phase.

## Order

```text
A. Generic SCPI Foundation
            |
            v
B. Multi-Instrument Foundation
            |
            +----------------------+
            |                      |
            v                      v
C. DM858E Backend           D. DM858E Frontend
            |                      |
            +-----------+----------+
                        |
                        v
               E. Integration
```

A and B are sequential prerequisites.

After B lands, C and D can proceed in parallel because B owns the shared DMM/protocol contracts and route/lifecycle foundation.

E integrates both branches and performs physical-instrument verification and acquisition benchmarking.

## A. Generic SCPI Foundation

Document: `dm858e-scpi-foundation.md`

Owns:

- remove scope-domain coupling from `ScpiScheduler`
- caller-owned opaque coalescing keys
- retain generic transport/framing
- migrate existing DHO804 callers
- preserve all existing scope behaviour/tests

Primary area:

```text
src/server/scpi/**
```

This stream contains no DM858E implementation.

## B. Multi-Instrument Foundation

Document: `dm858e-instrument-foundation.md`

Owns:

- React router and instrument shell
- `/` and `/dm858e` routes
- server instrument registration
- browser-session instrument subscriptions
- first-subscriber start / last-subscriber stop lifecycle
- per-instrument endpoint configuration
- DHO804 migration to route-driven runtime activation
- stable shared DMM types and WebSocket contracts
- SPA static-route fallback

This is the contract/foundation stream for C and D.

## C. DM858E Backend

Document: `dm858e-backend.md`

Owns:

- DM858E SCPI driver
- runtime/state ownership
- identity validation
- primary reading acquisition
- function/range/rate control
- raw SCPI scheduling
- simple state reconciliation/front-panel validation

Primary area:

```text
src/server/dmm/**
```

C consumes B's shared contracts and does not edit frontend code.

## D. DM858E Frontend

Document: `dm858e-frontend.md`

Owns:

- DMM store/client
- `/dm858e` screen
- stable large numeric readout
- function controls
- range controls
- rate/resolution controls
- connection state
- optional first-pass host statistics/trend UI where already covered by the shared contract
- instrument-aware raw SCPI console UI

Primary area:

```text
src/web/dmm/**
src/web/components/dmm/**
src/web/dmm-store.ts
```

D consumes B's shared contracts and can use fake messages/data until C is merged.

## E. Integration / Real Instrument

Document: `dm858e-integration.md`

Owns:

- backend/frontend wiring
- physical DM858E verification
- route/subscription lifecycle verification across both instruments
- real SCPI acquisition throughput measurements
- DHO804 regression pass
- only concrete contract corrections discovered during integration

## Shared-file rule

After B is merged, C and D should avoid changing the shared protocol/contracts.

If either stream discovers that a contract is genuinely impossible or contradictory, report the exact issue rather than locally redesigning it and forcing the other stream to chase the change.

E may make a small shared-contract correction when real combined implementation proves one necessary.

## Merge order

Recommended merge order:

```text
dm858e-scpi-foundation
dm858e-instrument-foundation
dm858e-backend
dm858e-frontend
dm858e-integration
```

Backend and frontend may be developed concurrently; the listed merge order simply reduces uncertainty.

After each merge run:

```text
pnpm typecheck
pnpm test
pnpm build
```

The physical DM858E is only required for stream E. C and D should be implementable with the Programming Guide and typed fakes.
