# DM858E A — Generic SCPI Foundation

## Audience

This is a self-contained implementation handoff for the first DM858E workstream.

Complete this stream before any DM858E route, runtime or UI work. The purpose is to make the existing SCPI foundation genuinely reusable by both supported instruments without changing DHO804 behaviour.

## Read before changing code

- `docs/architecture.md`
- `docs/scpi-scheduler.md`
- `docs/server-architecture.md`
- `docs/testing.md`
- `docs/development-practices.md`
- `docs/typescript-practices.md`
- `docs/dm858e-ui-plan.md`
- `src/server/scpi/scpi-transport.ts`
- `src/server/scpi/scpi-scheduler.ts`
- existing SCPI tests

## Objective

After this stream:

- `ScpiTransport` remains reusable and instrument-agnostic
- `ScpiScheduler` has no imports from scope domain types
- coalescing remains supported, but callers own the meaning of coalescing keys
- existing DHO804 behaviour and tests remain unchanged from the user's perspective
- no DM858E-specific code exists yet

Do not create a generic instrument framework. Generalize only infrastructure that is already shared by both real supported devices.

## Required changes

### Scheduler coalescing

Remove scope-domain knowledge from `src/server/scpi/scpi-scheduler.ts`.

Current scope-specific concepts such as channel scale, channel offset, horizontal position and trigger level must move to scope-owned code.

The scheduler should accept an opaque caller-provided coalescing key. The exact representation is an implementation choice, but it must:

- compare deterministically
- be impossible for the scheduler to interpret as a scope concept
- support multiple independent callers/runtimes without accidental collisions
- remain easy to test

Do not add compatibility aliases or dual APIs. This repository uses forward-only interface changes: update all callers directly.

### Operation kinds and priorities

Review `ScpiOperationKind` and `ScpiPriority` for domain leakage.

Priorities are shared infrastructure and should remain shared.

Operation kinds used only for metrics may remain explicit categories if they make sense across instruments, but scope-only categories such as waveform-specific work must not force DMM code into false semantics. Prefer a small generic classification surface plus caller-owned detail rather than a large cross-instrument enum.

Do not redesign scheduling policy unless required to remove scope coupling.

### Transport

Do not rewrite `ScpiTransport` merely because this stream exists.

Only change it if a concrete dependency on the DHO804 prevents reuse by the DM858E. Preserve text/binary response framing, timeouts, connection invalidation and tests.

### Scope caller migration

Update the existing scope code so it owns its own coalescing-key construction and passes opaque keys to the generic scheduler.

The DHO804 must retain:

- interactive coalescing
- immediate final interaction commits
- waveform/background priority behaviour
- raw SCPI serialization
- existing error/failure semantics

## Source ownership

Primary files owned by this stream:

```text
src/server/scpi/**
```

This stream may make the minimum required edits to existing scope callers and scheduler documentation.

Do not add:

```text
src/server/dmm/**
src/shared/dmm-types.ts
DM858E routes/components/stores
instrument registry/lifecycle code
```

Those belong to later streams.

## Tests

Add/adjust tests proving:

- scheduler coalescing works with opaque keys
- different opaque keys do not collide
- same-key pending interactive work is still coalesced
- immediate final operations still supersede pending interactive work correctly
- scheduler remains serial over one transport
- stopping/rejecting behaviour is unchanged
- existing scope runtime/control tests still pass

Run:

```text
pnpm typecheck
pnpm test
pnpm build
```

## Completion criteria

This stream is complete when `src/server/scpi/**` can be imported by a future DM858E runtime without importing any scope type or pretending DMM operations are scope operations, and all existing DHO804 behaviour remains green.

Do not start the router or DM858E implementation in this stream.
