# SCPI Scheduler

## Purpose

The SCPI scheduler is the sole owner of communication with the DHO804.

Its job is not merely to serialize commands. It exists to make the instrument feel responsive despite SCPI being a serialized stream with operations of very different cost.

No application code should write directly to the scope TCP socket.

## Goals

The scheduler should:

- preserve SCPI request/response ordering
- prioritise user interaction over background work
- make continuous controls run as quickly as the DHO804 can usefully consume updates
- discard useless intermediate interactive values
- prevent stale waveform work from delaying controls
- prevent background polling from delaying controls
- correctly handle binary waveform transactions
- expose timing information so performance can be measured
- remain simple enough to reason about

## Persistent transport

The server maintains one persistent TCP socket to the DHO804.

Configure it for low latency:

```ts
socket.setNoDelay(true);
socket.setKeepAlive(true);
```

A query is not complete until its full response has been consumed.

A binary-block query is not complete until the entire SCPI/IEEE binary block has been read.

No later operation may consume bytes belonging to an earlier transaction.

## Priority classes

Initial priorities:

```text
P0 Immediate
P1 Interactive
P2 Normal
P3 Waveform
P4 Background
```

### P0: Immediate

Examples:

- Stop
- Run
- Single
- final value at the end of a continuous interaction

These run before queued work that has not already begun.

An already-running SCPI transaction generally cannot be interrupted safely.

### P1: Interactive

Examples:

- vertical offset drag
- trigger level drag
- horizontal position drag
- other continuous controls

These use latest-value-wins coalescing.

### P2: Normal

Examples:

- channel enable/disable
- coupling
- probe ratio
- measurement configuration
- ordinary discrete UI operations
- SCPI console commands unless explicitly elevated

### P3: Waveform

Live waveform retrieval.

Waveform acquisition starts only when no higher-priority useful work is waiting.

Live waveform transactions must remain deliberately small because once a `WAV:DATA?` transfer has begun, it cannot generally be preempted safely.

### P4: Background

Examples:

- ~1 Hz state validation
- low-priority capability/state checks
- non-interactive maintenance

Background work should run only when it will not affect perceived responsiveness.

## Selection rules

When the SCPI transport becomes idle:

1. select the highest-priority pending operation
2. preserve ordering within a priority unless the operation explicitly supports coalescing
3. do not begin lower-priority work while known higher-priority work is pending

The scheduler executes one complete SCPI transaction at a time.

## Interactive coalescing

Continuous controls must not create FIFO backlogs.

For each coalescible key there may be:

- one operation currently executing
- at most one pending desired value

Example:

```text
currently writing CH1 offset: 0.100 V
pending: 0.105 V

new value: 0.110 V
pending becomes 0.110 V

new value: 0.125 V
pending becomes 0.125 V
```

When the current write finishes, send `0.125 V`.

The intermediate values are stale before they could reach the instrument and should be discarded.

Coalescing keys should identify the semantic control, for example:

```text
channel:1:offset
channel:1:scale
trigger:level
horizontal:position
```

## No arbitrary interaction rate limit

Do not initially throttle continuous controls to a hard-coded frequency such as 10 Hz, 20 Hz or 30 Hz.

Instead:

- if the transport is idle, send immediately
- if an equivalent operation is already in flight, retain only the newest pending value
- when the transport becomes available, send that newest value immediately

This naturally approaches the maximum useful rate the DHO804 and network path can sustain.

Add rate limiting later only if measurements demonstrate a specific need.

## Final interaction value

Ending an interaction is different from intermediate movement.

On pointer-up or equivalent completion:

1. submit the final desired value as P0
2. ensure it cannot be lost through intermediate-value coalescing
3. execute it as soon as the current SCPI transaction permits
4. query that property from the scope
5. reconcile cached/browser state with the returned authoritative value

This catches:

- rounding
- clamping
- discrete supported values
- rejected values
- other instrument behaviour

Do not perform authoritative readback for every intermediate drag value.

## Optimistic state

Interactive controls are optimistic.

The UI should not wait for a SCPI round trip before visually reflecting pointer movement.

Where needed internally, distinguish explicitly between:

- desired value
- last transmitted value
- authoritative scope value

Do not model these distinctions using arbitrary optional properties.

## Poll interaction

The ~1 Hz state validator belongs to P4.

It must not fight active interaction.

For a property currently being manipulated:

- polling may continue for unrelated properties
- a stale poll result must not overwrite the active desired UI value
- after interaction completes, explicit readback re-establishes authoritative state

## Waveform scheduling

Live waveform acquisition belongs to P3.

Do not build a FIFO queue of waveform requests.

There should effectively be at most:

- one waveform acquisition in progress
- one indication that another fresh waveform is wanted

If many requests accumulate while one waveform read is in progress, collapse them into one future acquisition.

The application wants the newest waveform, not every waveform.

## Browser backpressure

Browser delivery has separate backpressure from the SCPI scheduler.

If newer waveform data exists while older unsent waveform data is still queued:

- discard stale waveform data
- retain the newest waveform
- preserve control/state/error messages

Waveform streaming is intentionally lossy.

## Configuration caching

Avoid repeatedly sending SCPI setup commands that are already known to be active.

For example, do not blindly send this before every frame:

```text
:WAV:SOUR CHAN1
:WAV:MODE NORM
:WAV:FORM WORD
:WAV:POIN 1000
:WAV:DATA?
```

Cache transport-relevant waveform configuration and only send commands when the required configuration changes.

The cache is an optimisation, not the final source of truth. The ~1 Hz state validation and explicit readbacks remain responsible for detecting relevant drift.

## Cancellation and supersession

Queued operations may be superseded before execution if their semantics allow it.

Examples:

- intermediate drag values: supersedable
- pending live waveform request: supersedable

Examples that are not supersedable by default:

- Stop
- Run
- Single
- explicit SCPI console command
- commands with externally visible side effects

Do not add a generic `optional cancellation` field to every operation. Model cancellation/supersession explicitly by operation kind.

## Errors

Errors must fail loudly and predictably.

A transport/query failure should not silently produce a partially valid response object.

Prefer explicit result/state variants or thrown errors over optional response fields whose absence means multiple unrelated things.

A broken SCPI transaction may leave stream framing uncertain. When framing integrity cannot be guaranteed, disconnect and recreate the persistent scope connection rather than guessing where the next response begins.

## Instrumentation

Performance is a first-class concern. Record enough timing data to identify where latency comes from.

At minimum track:

- queue wait time
- SCPI write duration
- query response latency
- binary transfer duration and byte count
- operation kind/priority
- coalesced operation count
- waveform requests skipped/superseded

This data should make it possible to determine whether latency is caused by:

- browser/WebSocket path
- scheduler backlog
- TCP transport
- DHO command processing
- waveform transfer size

Optimise from measurements rather than assumptions.

## Design rule

Responsiveness wins over processing every intermediate event.

For continuous controls and live waveforms, current state is valuable and stale state is not.
