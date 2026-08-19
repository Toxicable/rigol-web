# Development Practices

## Purpose

These conventions describe how Rigol Web should be implemented.

Rigol Web is a personal local-network tool for one known oscilloscope. Prefer code that is direct, easy to debug and fast to change over abstractions intended for hypothetical future users, instruments or deployment environments.

## Simplicity first

Do not add architecture merely because it is common in larger systems.

Avoid by default:

- generic instrument frameworks
- dependency injection frameworks
- generic event buses
- repository/service/domain layers that add no useful boundary
- persistent command queues
- circuit breakers
- per-command retry policies
- complex degraded-mode handling
- abstraction for hardware that Rigol Web does not support

Add complexity when a measured problem or concrete requirement justifies it.

## Fail loudly

Prefer obvious failures over complicated recovery behaviour.

If a required condition is not met, throw or transition to an explicit failed/disconnected state rather than continuing with partially valid data.

Examples:

- malformed SCPI response: fail the transaction
- broken SCPI framing: close the connection rather than guessing where the next response begins
- missing required configuration: fail startup rather than inventing a default
- invalid protocol message: reject it rather than accepting a partial interpretation

The project does not need high-availability behaviour. A visible failure that can be diagnosed and fixed is preferable to code that silently limps along.

Reconnect behaviour should remain simple. Do not build elaborate replay or recovery machinery unless actual use demonstrates a need for it.

## TypeScript types

Use explicit, strong types.

A field should be optional only when absence has real domain meaning. Do not use `undefined`, `null` or optional members merely to make construction easier.

Prefer discriminated unions when an object has genuinely different valid states.

For fixed protocol/domain values, prefer actual numeric TypeScript enums rather than string enums.

```ts
export enum ScopeConnectionState {
  Disconnected = 0,
  Connecting = 1,
  Connected = 2,
}
```

Protocol enum values should be assigned deliberately and remain stable once used on the wire.

Use descriptive object property names even when enum values are numeric. Do not compress the protocol into positional arrays merely to save a few bytes.

## Naming

Filenames use lowercase kebab-case.

Examples:

```text
scpi-transport.ts
scpi-scheduler.ts
dho804-driver.ts
scope-controller.ts
live-waveform-service.ts
```

Types, classes and enums use normal TypeScript PascalCase naming inside those files.

Do not use `index.ts` files as barrel exports or generic entrypoint names. Import from the file that owns the symbol and give executable entrypoints descriptive names such as `server.ts`.

## Module boundaries

Prefer a small number of concrete modules with clear ownership.

Important boundaries:

- `scpi-transport.ts` owns the TCP stream and SCPI response framing
- `scpi-scheduler.ts` owns serialized access, priority and coalescing
- `dho804-driver.ts` owns DHO804-specific SCPI commands and parsing
- `scope-controller.ts` owns application-level control semantics
- waveform services own live/deep waveform behaviour
- the WebSocket layer owns transport between browser and server, not scope behaviour

Avoid bypassing these boundaries for convenience. In particular, application code must not write directly to the scope socket.

## Performance

Responsiveness is a primary requirement, especially for continuous interaction.

Prefer designs that avoid unnecessary work in the critical path:

- optimistic local UI updates during dragging
- latest-value-wins coalescing for continuous SCPI writes
- no readback after every intermediate drag value
- waveform data bypasses React state
- live waveform frames are disposable
- deep captures are downsampled to display resolution

Do not add arbitrary throttles or complicated optimisations without measurement. Instrument important paths and optimise based on observed latency.

## State and data ownership

Keep ownership obvious.

- the DHO804 is authoritative for live scope state
- the server owns the cached `ScopeState`
- the server owns complete deep captures
- the browser owns transient presentation state
- uPlot receives display-sized waveform data and does not own acquisition state

Avoid maintaining multiple competing authoritative copies of the same state.

## Scope of the project

Design for the DHO804 and the current application first.

Do not generalise a type, interface or module solely because another Rigol model or another instrument might be supported someday. Extract common abstractions later if real duplication appears.

The goal is a responsive and maintainable tool, not a reusable instrumentation framework.
