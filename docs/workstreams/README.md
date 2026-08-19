# Implementation Workstreams

## Purpose

Rigol Web is split into implementation streams so multiple coding agents/branches can work with minimal overlap.

The architecture and shared contracts are already defined in `docs/`. Each workstream document is intended to be handed directly to an implementation agent.

## Order

```text
A. Foundation
      |
      +----------------+----------------+----------------+
      |                |                |                |
      v                v                v                v
B. SCPI backend   C. Server control  D. Waveforms   E. Frontend
      |                |                |                |
      +----------------+----------------+----------------+
                               |
                               v
                        F. Integration
```

After Foundation lands, B/C/D/E can proceed in parallel.

Server Control and Waveforms consume the documented `Dho804Driver` surface. They do not need to wait for its implementation to be merged; their tests can use small typed fakes matching the handoff contract.

Integration happens after the four implementation streams are merged.

## A. Foundation

Document: `foundation.md`

Owns:

- package/tooling setup
- minimal Node/React shells
- `src/shared/scope-types.ts`
- `src/shared/websocket-protocol.ts`
- `src/shared/waveform-protocol.ts`

It deliberately implements no scope behaviour.

## B. SCPI backend

Document: `scpi-backend.md`

Owns:

- TCP/SCPI transport
- IEEE/TMC framing
- P0-P4 scheduler
- coalescing and scheduler metrics
- DHO804 SCPI commands/parsing
- normalized single-channel live/RAW waveform reads

Main source areas:

```text
src/server/scpi/**
src/server/scope/dho804-driver.ts
```

## C. Server control

Document: `server-control.md`

Owns:

- authoritative cached state
- optimistic control semantics
- final interaction readback
- approximately 1 Hz validation poll
- JSON WebSocket gateway/validation
- browser state/result broadcasting

Main source areas:

```text
src/server/scope/scope-state-store.ts
src/server/scope/scope-controller.ts
src/server/scope/scope-poller.ts
src/server/websocket/**
```

## D. Waveforms

Document: `waveforms.md`

Owns:

- multi-channel live acquisition loop
- exact browser binary frame encoding
- latest completed deep capture
- server-side min/max downsampling
- overscanned deep viewport generation

Main source area:

```text
src/server/waveform/**
```

## E. Frontend

Document: `frontend.md`

Owns:

- React/Zustand application
- browser WebSocket client
- binary waveform decoding
- waveform caches/controller
- uPlot mode-2 renderer
- scope controls/interactions
- measurements and SCPI console UI

Main source area:

```text
src/web/**
```

## F. Integration

Document: `integration.md`

Owns:

- `ScopeRuntime`
- final `server.ts`
- dev proxy/static production serving
- simple scope reconnect lifecycle
- cross-stream wiring
- real DHO804 verification
- real performance benchmark pass

Main integration files:

```text
src/server/scope-runtime.ts
src/server/server.ts
vite.config.ts
package.json
scripts/*scope*.ts
```

## Shared-file rule

Once Foundation is merged, B/C/D/E should avoid editing `src/shared/**`.

If a stream discovers that a shared contract is genuinely impossible or contradictory, stop and report the exact issue rather than locally changing the wire/domain contract and forcing the other branches to chase it.

Integration can make a small shared-contract correction if real combined implementation proves one necessary, but broad protocol redesign is not part of integration.

## Merge order

A useful merge sequence is:

```text
foundation
scpi-backend
server-control
waveforms
frontend
integration
```

The middle four do not have to be developed in that order. The sequence only reduces merge-time uncertainty by landing the low-level backend first.

After each merge run:

```text
pnpm typecheck
pnpm test
pnpm build
```

The physical DHO804 is only required during the final explicit integration/benchmark pass, not normal unit tests.