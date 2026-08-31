# Development Practices

## Purpose

These conventions describe how Rigol Web should be implemented at the project level.

Rigol Web is a personal local-network tool for two known instruments: the DHO804 and DM858E. Prefer code that is direct, easy to debug and fast to change over abstractions intended for hypothetical future users, arbitrary instruments or deployment environments.

TypeScript-specific type and naming conventions are documented separately in `typescript-practices.md`.

## Simplicity first

Do not add architecture merely because it is common in larger systems.

Avoid by default:

- generic instrument/plugin frameworks
- dependency injection frameworks
- generic event buses
- repository/service/domain layers that add no useful boundary
- persistent command queues
- circuit breakers
- per-command retry policies
- complex degraded-mode handling
- abstraction for hardware Rigol Web does not support

Share a boundary when the DHO804 and DM858E have a real common need, such as SCPI transport/scheduling or subscription-owned runtime activation. Keep device state, controls and exact command semantics separate when they differ.

Add complexity only when a concrete requirement or measurement justifies it.

## Fail loudly

Prefer obvious failures over complicated recovery behaviour.

If a required condition is not met, fail clearly rather than continuing with partially valid data.

Examples:

- malformed SCPI response: fail the transaction
- broken SCPI framing: close the affected instrument connection rather than guessing where the next response begins
- missing required configuration: fail startup rather than inventing a default
- protocol version mismatch: close the browser socket clearly before instrument traffic
- invalid protocol message: reject it rather than accepting a partial interpretation

The project does not need high-availability behaviour. A visible failure that can be diagnosed and fixed is preferable to code that silently limps along.

Reconnect behaviour should remain simple. Do not build elaborate replay or recovery machinery unless actual use demonstrates a need for it.

## Clear ownership

Prefer a small number of concrete modules with clear ownership.

Avoid bypassing module boundaries for convenience. In particular:

- application code must not write directly to an instrument socket
- DHO804-specific command knowledge belongs in the DHO804 driver
- DM858E-specific command knowledge belongs in the DM858E driver
- scope application semantics remain above the DHO804 driver
- DMM application semantics remain above the DM858E driver
- waveform acquisition/downsampling remains DHO804-specific
- the instrument registry owns activation/subscription lifecycle, not instrument commands
- the WebSocket layer transports and routes application messages; it does not become device-control logic

See `server-architecture.md` for the detailed server boundaries.

## Interface changes

The project owns browser and server callers together. Make hard cuts when a shared contract changes rather than keeping compatibility defaults or dual protocol surfaces.

Examples:

- raw SCPI requires an explicit instrument target everywhere
- protocol version changes are explicit and handshake-validated
- old configuration names are not retained as aliases when endpoint configuration changes

## Performance

Responsiveness is a primary requirement, especially for DHO804 continuous interaction.

Prefer designs that avoid unnecessary work in critical paths:

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
- the DM858E is authoritative for DMM state/readings
- the server owns cached authoritative instrument state
- the server owns complete DHO804 deep captures
- browser transport state is separate from either physical instrument lifecycle
- the browser owns transient presentation state
- uPlot receives display-sized DHO804 waveform data and does not own acquisition state

Avoid maintaining multiple competing authoritative copies of the same state.

## Scope of the project

Design for the DHO804, DM858E and current application.

Do not generalise a module solely because a third model or arbitrary instrument might be supported someday. Extract common code only when real duplication or a shared requirement exists now.

The goal is a responsive and maintainable bench tool, not a reusable instrumentation framework.
