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
- allow a small number of semantic operations to keep several SCPI transactions atomic
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

## Transaction versus scheduled operation

A **transport transaction** is one command/query exchange such as:

```text
:CHAN1:OFFS 0.1
```

or:

```text
:CHAN1:OFFS?
<text response>
```

or:

```text
:WAV:DATA?
<complete IEEE/TMC binary block>
```

A **scheduled operation** is the unit selected by scheduler priority.

Most scheduled operations contain exactly one transport transaction.

A small number of driver operations need several transport transactions to remain together because another operation changing scope configuration in the middle would make the result ambiguous. Waveform acquisition is the main example:

```text
set source/mode/format/range as required
query waveform data
query/read metadata belonging to that waveform
```

The scheduler therefore supports an exclusive operation callback that may execute several transport transactions while retaining scheduler ownership.

Conceptually:

```ts
schedule<T>({
  priority,
  kind,
  execute: async transport => {
    // one or more complete ScpiTransport transactions
    return result;
  },
}): Promise<T>;
```

The exact API can use overloads/distinct operation variants, but preserve this ownership rule:

**Only the scheduler invokes `ScpiTransport` transaction methods.**

The DHO804 driver may define the contents of an exclusive scheduled operation through the scheduler API. Higher application layers never receive direct transport access.

## Atomicity rule

Priority is reconsidered **between scheduled operations**, not between transport transactions inside one already-started exclusive operation.

Therefore:

- a simple channel write is preemptible after its one transaction completes
- a live waveform read keeps its setup/data/metadata sequence together
- a chunked RAW channel read can keep all chunks/configuration together
- P0 work cannot interrupt an exclusive operation that has already started

Keep exclusive multi-transaction operations rare and deliberately bounded where possible.

Do not wrap the approximately 1 Hz complete state validation in one exclusive operation. Its individual background queries should yield to P0/P1 work between queries. The controller's mutation-revision rule handles a state snapshot that became stale while being assembled.

## Priority classes

Initial priorities:

```text
P0 Immediate
P1 Interactive
P2 Normal
P3 Waveform
P4 Background
```

In code:

```ts
export enum ScpiPriority {
  Immediate = 0,
  Interactive = 1,
  Normal = 2,
  Waveform = 3,
  Background = 4,
}
```

Smaller numeric value means higher priority.

### P0: Immediate

Examples:

- Stop
- Run
- Single
- final value at the end of a continuous interaction
- focused readback following that final write

These run before queued work that has not already begun.

An already-running scheduled operation cannot generally be interrupted safely.

### P1: Interactive

Examples:

- vertical offset drag
- trigger level drag
- horizontal position drag
- gesture-driven scale changes

These use latest-value-wins coalescing.

### P2: Normal

Examples:

- channel enable/disable
- coupling
- probe ratio
- ordinary discrete UI operations
- SCPI console commands
- explicit deep/RAW capture work before it starts

Deep capture is deliberate and may become a long exclusive operation once selected. It is not live background work.

### P3: Waveform

Recurring live waveform retrieval.

Live waveform acquisition starts only when no higher-priority useful work is waiting.

Live waveform operations must remain deliberately small because once the operation has begun, especially once `:WAV:DATA?` transfer starts, it cannot safely be preempted.

### P4: Background

Examples:

- approximately 1 Hz state validation queries
- measurement reads
- low-priority capability/state checks

Background work should run only when it will not affect perceived responsiveness.

## Selection rules

When the scheduler becomes idle:

1. select the highest-priority pending scheduled operation
2. preserve ordering within a priority unless the operation explicitly supports coalescing/supersession
3. do not begin lower-priority work while known higher-priority work is pending
4. once an operation begins, let its defined transport sequence finish or fail before selecting another

There is always only one scheduled operation executing against the persistent scope connection.

## Interactive coalescing

Continuous controls must not create FIFO backlogs.

For each coalescible key there may be:

- one operation currently executing
- at most one pending desired value

Use semantic numeric coalescing kinds rather than arbitrary string paths:

```ts
export enum ScpiCoalesceKind {
  ChannelScale = 1,
  ChannelOffset = 2,
  HorizontalScale = 3,
  HorizontalPosition = 4,
  TriggerLevel = 5,
}
```

Channel controls include a required `Channel` in their coalescing key. Non-channel controls use a different required shape rather than an optional channel property.

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

## No arbitrary interaction rate limit

Do not initially throttle continuous controls to a hard-coded frequency such as 10 Hz, 20 Hz or 30 Hz.

Instead:

- if the scheduler is idle, send immediately
- if an equivalent operation is already in flight, retain only the newest pending value
- when the scheduler becomes available, send that newest value immediately

This naturally approaches the maximum useful rate the DHO804 and network path can sustain.

Add rate limiting later only if measurements demonstrate a specific need.

## Final interaction value

Ending an interaction is different from intermediate movement.

On pointer-up or equivalent completion:

1. submit the final desired value as P0
2. ensure it cannot be lost through intermediate-value coalescing
3. execute it as soon as the current scheduled operation permits
4. query that property at P0
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

The approximately 1 Hz state validator belongs to P4.

Its individual queries are ordinary short background operations, so higher-priority work can run between them.

The resulting snapshot may therefore be stale if the user changes something while it is being assembled. The controller captures a mutation revision at the start and discards the complete polled snapshot if a local mutation occurred before it finished.

This is preferable to making the entire multi-query poll one long exclusive operation.

## Live waveform scheduling

Live waveform acquisition belongs to P3.

Do not build a FIFO queue of waveform requests.

There should effectively be at most:

- one live waveform acquisition in progress
- one indication that another fresh waveform is wanted

If many requests accumulate while one waveform operation is in progress, collapse them into one future acquisition.

The application wants the newest waveform, not every waveform.

### Live waveform atomicity

One single-channel live read is one exclusive P3 scheduled operation.

Within that operation, the DHO804 driver may:

- apply only waveform setup values that need changing
- issue `:WAVeform:DATA?`
- obtain the associated metadata

No other scheduled operation may change waveform source/configuration between those steps.

Keep NORMAL point count small so this exclusive P3 operation has low worst-case latency.

A four-channel live refresh is **not** one exclusive operation. Each channel read is separate, allowing P0/P1 work between channels.

## Deep/RAW scheduling

Deep capture is an explicit user action while stopped.

A single channel RAW read is one exclusive P2 scheduled operation because source/mode/format/start/stop/chunk sequence and metadata must describe one coherent acquisition.

If the driver retrieves the channel in multiple `STARt`/`STOP` chunks, those chunks stay inside the same scheduled operation. Do not allow live waveform setup, raw console commands or Run to slip between chunks and mutate the acquisition/configuration being captured.

This means an already-started large RAW channel operation can delay a later P0 command. That is acceptable for an explicit deep capture; measure real DHO804 transfer duration and choose a sensible chunk/native strategy, but do not sacrifice capture correctness by pretending it is safely preemptible.

Between channels of a multi-channel deep capture, the waveform service/driver may return to the scheduler. The deep-capture service should still fail the capture if scope state changes invalidate consistency before all selected channels complete.

## Browser backpressure

Browser delivery has separate backpressure from the SCPI scheduler.

If newer waveform data exists while older unsent waveform data is still queued:

- discard stale waveform data
- retain the newest waveform
- preserve control/state/error messages

Waveform streaming is intentionally lossy.

## Configuration caching

Avoid repeatedly sending SCPI setup commands that are already known to be active.

For example, do not blindly send this before every frame if the configuration has not changed:

```text
:WAV:SOUR CHAN1
:WAV:MODE NORM
:WAV:FORM WORD
:WAV:POIN 1000
```

Cache transport-relevant waveform configuration and only send commands when the required configuration changes.

The cache must be invalidated when its truth is no longer knowable, especially after reconnect or a raw SCPI console command that could change waveform setup.

The cache is an optimisation, not application scope state.

## Cancellation and supersession

Queued operations may be superseded before execution if their semantics allow it.

Examples:

- intermediate drag values: supersedable
- pending live waveform request: supersedable

Examples that are not supersedable by default:

- Stop
- Run
- Single
- interaction commit
- explicit SCPI console command
- an exclusive operation that has already begun
- commands with externally visible side effects

Do not add a generic optional cancellation field to every operation. Model supersession explicitly by operation kind.

## Errors

Errors must fail loudly and predictably.

A transport/query failure should not silently produce a partially valid response object.

Prefer explicit result/state variants or thrown errors over optional response fields whose absence means multiple unrelated things.

A broken SCPI transaction may leave stream framing uncertain. When framing integrity cannot be guaranteed, disconnect and recreate the persistent scope connection rather than guessing where the next response begins.

Failure of any transaction inside an exclusive scheduled operation fails that whole operation.

## Instrumentation

Performance is a first-class concern. Record enough timing data to identify where latency comes from.

At minimum track:

- scheduled-operation queue wait time
- total scheduled-operation duration
- individual SCPI transaction/query latency where useful
- binary transfer duration and byte count
- operation kind/priority
- coalesced operation count
- waveform requests skipped/superseded

This data should make it possible to determine whether latency is caused by:

- browser/WebSocket path
- scheduler backlog
- TCP transport
- DHO command processing
- waveform setup overhead
- waveform transfer size

Optimise from measurements rather than assumptions.

## Design rule

Responsiveness wins over processing every intermediate event, but response ordering and waveform/capture correctness come first.

For continuous controls and live waveforms, current state is valuable and stale state is not. For multi-transaction operations whose meaning depends on stable DHO804 configuration, keep the operation atomic rather than allowing unsafe interleaving.