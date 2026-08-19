# Development Practices

## Purpose

These conventions describe how Rigol Web should be implemented at the project level.

Rigol Web is a personal local-network tool for one known oscilloscope. Prefer code that is direct, easy to debug and fast to change over abstractions intended for hypothetical future users, instruments or deployment environments.

TypeScript-specific type and naming conventions are documented separately in `typescript-practices.md`.

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

If a required condition is not met, fail clearly rather than continuing with partially valid data.

Examples:

- malformed SCPI response: fail the transaction
- broken SCPI framing: close the connection rather than guessing where the next response begins
- missing required configuration: fail startup rather than inventing a default
- invalid protocol message: reject it rather than accepting a partial interpretation

The project does not need high-availability behaviour. A visible failure that can be diagnosed and fixed is preferable to code that silently limps along.

Reconnect behaviour should remain simple. Do not build elaborate replay or recovery machinery unless actual use demonstrates a need for it.

## Clear ownership

Prefer a small number of concrete modules with clear ownership.

Avoid bypassing module boundaries for convenience. In particular:

- application code must not write directly to the scope socket
- DHO804-specific command knowledge belongs in the DHO804 driver
- application control semantics belong above the driver
- waveform acquisition/downsampling belongs in the waveform layer
- the WebSocket layer transports application messages and should not become the scope-control implementation

See `server-architecture.md` for the detailed server boundaries.

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

The application runs on a local network, so low interaction latency is generally more valuable than aggressively minimizing bandwidth or payload size.

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

Do not generalise a module solely because another Rigol model or another instrument might be supported someday. Extract common abstractions later if real duplication appears.

The goal is a responsive and maintainable tool, not a reusable instrumentation framework.