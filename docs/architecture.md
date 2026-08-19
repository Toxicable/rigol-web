# Rigol Web Architecture

## Purpose

Rigol Web is a local web interface for a Rigol DHO804 oscilloscope.

The goal is to provide a faster, clearer and more flexible interface than the scope UI while retaining direct access to native scope capabilities through SCPI.

This is a personal project. The initial design should not be distorted by requirements for commercial deployment, arbitrary instruments, hostile multi-user environments or hypothetical future hardware.

## Target hardware

Initial target:

- Rigol DHO804 only
- Ethernet connection
- Raw SCPI over a persistent TCP connection
- Behaviour based on the Rigol DHO800/DHO900 Programming Guide and DHO800 User Guide

Support for other instruments can be considered later. Do not build a generic instrument framework now.

## Technology

The application is entirely TypeScript.

```text
Browser
   |
   | WebSocket
   v
Rigol Web server
   |
   | persistent TCP / SCPI
   v
Rigol DHO804
```

Tentative stack:

- Node.js + TypeScript server
- React + TypeScript frontend
- Vite
- Canvas or WebGL waveform rendering
- one WebSocket connection between browser and server

HTTP is only needed to serve the frontend and simple infrastructure endpoints such as health checks.

## Scope connection

The server maintains one persistent TCP connection to the DHO804.

All SCPI operations pass through a dedicated scheduler/transport layer. Application code must not write directly to the scope socket.

Reasons:

- SCPI query responses must remain associated with the correct request
- binary waveform transfers must remain atomic
- interactive operations need priority over background work
- continuous controls need coalescing
- polling must not interfere with interaction

The scheduler is documented separately in `scpi-scheduler.md`.

## Browser connection

The browser uses one persistent WebSocket connection to the server.

The WebSocket carries:

- commands
- scope state and state changes
- measurements
- errors
- SCPI console requests/responses
- waveform data

Control/state messages may use JSON.

Waveform samples should use binary WebSocket frames rather than JSON arrays.

WebSocket compression should be disabled initially. This runs on a local network, so responsiveness and low latency matter more than reducing bandwidth.

## Scope state

The physical oscilloscope is the authoritative source of state.

The server maintains a cached model of important scope state, including at least:

- channel enable state
- channel vertical scale
- channel vertical offset
- coupling
- probe ratio
- horizontal scale
- horizontal position
- sample rate
- memory depth
- trigger type
- trigger source
- trigger level
- trigger slope
- acquisition state

Web interactions update the UI optimistically so controls feel immediate.

Ordinary discrete operations may be read back immediately where useful. Continuous interactions are not read back on every intermediate value.

## State validation

Important scope state is polled at approximately 1 Hz.

The poll exists primarily to detect:

- changes made with the physical scope controls
- changes from another SCPI client
- drift between cached and real scope state

Polling is not the primary propagation path for changes made by Rigol Web.

Properties currently being manipulated interactively must not be overwritten by stale poll results. After an interaction completes, the final value is explicitly read back and reconciled.

## Interaction model

Continuous controls are performance-critical.

Examples:

- vertical offset
- trigger level
- horizontal position
- other draggable/continuous controls

During interaction:

1. the browser updates its local display immediately
2. the browser sends the desired value over the WebSocket
3. the server scheduler coalesces equivalent pending operations
4. the latest useful value is sent to the scope as soon as the SCPI connection is available

Intermediate values may be discarded if the scope cannot consume them quickly enough.

There should be no arbitrary fixed-rate throttle unless measurement shows one is required.

When the interaction ends, the final value must be sent with highest priority, then read back from the scope and reconciled.

## Waveform acquisition

The application deliberately separates live display acquisition from deep acquisition.

### Live display

While running:

- use the DHO waveform NORMAL/screen path
- keep waveform reads small
- optimise for transaction latency
- stale waveform frames may be discarded

The live display is for responsiveness, not complete acquisition memory.

### Deep acquisition

When stopped or after a single acquisition:

- use RAW waveform acquisition
- allow large acquisition-memory transfers
- treat the transfer as an explicit long-running operation

Deep acquisition must not be part of the normal live-display loop.

## Waveform rendering

The browser renders numerical waveform samples itself.

Waveform frames must carry enough metadata to convert samples to real time/voltage values, including the equivalent of:

- channel
- sample count
- X increment
- X origin
- X reference
- Y increment
- Y origin
- Y reference

The DHO804 is a 12-bit scope, so 16-bit sample storage is a natural representation for WORD waveform data.

## Backpressure

Live waveform data is disposable.

If the browser cannot keep up:

- drop stale waveform frames
- prefer the newest waveform
- never discard control, state or error messages merely to preserve old waveform data

The live stream represents current state, not an event log.

## Version 1 scope

Initial functionality:

- connect to DHO804
- connection/status information
- live waveform display
- CH1-CH4 enable/disable
- vertical scale
- vertical offset
- horizontal scale
- horizontal position
- Run / Stop / Single
- basic edge trigger configuration
- basic measurements
- raw SCPI console
- deep waveform retrieval while stopped

More of the DHO804 command set can be added incrementally after the interaction model performs well.

## TypeScript design rules

Prefer explicit, strong types.

A property must not be optional merely because making it optional is convenient.

If a value must exist for an object to be valid, require it in the type.

Avoid this:

```ts
interface ScopeState {
  channels?: ChannelState[];
  trigger?: TriggerState;
}
```

Prefer this:

```ts
interface ScopeState {
  channels: ChannelState[];
  trigger: TriggerState;
}
```

Use optional properties only when absence has genuine domain meaning.

Where state legitimately has multiple forms, prefer discriminated unions rather than bags of optional fields.

```ts
type ScopeConnection =
  | { state: "disconnected" }
  | {
      state: "connected";
      identity: ScopeIdentity;
      scope: ScopeState;
    };
```

Do not use `undefined`, nullable values or optional members as substitutes for modelling actual states.

## References

Primary specification/reference material:

- Rigol DHO800/DHO900 Programming Guide
- Rigol DHO800 User Guide

Useful implementation references:

- ngscopeclient / scopehal Rigol driver
- SCPI-Instrument-Control web gateway
- SCPI-Web-Interface

The Rigol manuals define expected device behaviour. Open-source projects are implementation references, not specifications.
