# SCPI Scheduler

## Purpose

`ScpiScheduler` serializes work for one `ScpiTransport` and applies priority/supersession policy before an operation begins.

It is shared SCPI infrastructure. It does not know which instrument is attached and must not import scope, DMM or other instrument-domain types.

Only scheduled operation callbacks invoke `ScpiTransport` transaction methods. Higher application layers do not write directly to the instrument socket.

## Goals

The scheduler should:

- preserve SCPI request/response ordering
- prioritise interactive work over background work
- coalesce stale continuous-control writes
- supersede stale keyed latest-value work such as live waveform requests
- keep multi-transaction operations atomic once selected
- expose basic operation timing and byte-count metrics
- fail pending work when the transport becomes unusable
- remain instrument-agnostic and simple to reason about

## Persistent transport

A runtime normally keeps one persistent `ScpiTransport` per active instrument session.

A query is not complete until its full response has been consumed. A binary-block query is not complete until the entire SCPI/IEEE block has been read. No later operation may consume bytes belonging to an earlier transaction.

## Transaction versus scheduled operation

A transport transaction is one command/query exchange. A scheduled operation is the unit selected by scheduler priority.

Most scheduled operations contain one transport transaction. Some instrument operations need several transactions to remain together because another command in the middle would invalidate the result. Those transactions stay inside one scheduled callback.

Conceptually:

```ts
schedule<T>({
  priority,
  kind,
  execute: async (transport, recorder) => {
    // one or more complete ScpiTransport transactions
    return result;
  },
}): Promise<T>;
```

Priority is reconsidered between scheduled operations, not inside one already-started operation.

## Priority classes

```ts
export enum ScpiPriority {
  Immediate = 0,
  Interactive = 1,
  Normal = 2,
  Waveform = 3,
  Background = 4,
}
```

Smaller numeric values are higher priority.

The priority classes are shared infrastructure. A runtime uses only the classes that make sense for that instrument.

### P0 Immediate

Examples for the scope runtime include Run, Stop, Single and the final value at the end of a continuous interaction.

### P1 Interactive

Continuous controls use latest-value-wins coalescing.

### P2 Normal

Ordinary discrete UI operations, raw SCPI console commands and explicit user-initiated work.

### P3 Waveform

Recurring live waveform acquisition for the scope runtime.

### P4 Background

Low-priority state validation, measurement reads and capability/state checks.

## Selection rules

When the scheduler becomes idle:

1. select the highest-priority pending scheduled operation
2. preserve FIFO ordering within a priority unless the operation explicitly supports coalescing/supersession
3. do not begin lower-priority work while higher-priority work is pending
4. once an operation begins, let its transport sequence finish or fail before selecting another

There is only one scheduled operation executing against a scheduler's transport at a time.

## Caller-owned keys

The scheduler accepts an opaque caller-owned `ScpiCoalesceKey` for work that can be coalesced or superseded.

Current representation:

```ts
export type ScpiCoalesceKey = symbol;
```

The scheduler compares keys only by identity. It does not serialize them and cannot interpret them as channel scale, trigger level, DMM range, waveform stream or any other instrument concept.

Callers create and retain stable symbols for work that belongs to the same semantic stream. Different symbols never collide even when they have the same description, so separate runtimes and unrelated workloads cannot accidentally supersede each other.

## Interactive coalescing

The DHO804 driver owns distinct symbols for:

- each channel scale
- each channel offset
- horizontal scale
- horizontal position
- trigger level

For each interactive key there may be one operation currently executing and at most one pending desired value. New pending work for the same key replaces the older pending operation while preserving all waiters.

## Final interaction value

Ending an interaction is different from intermediate movement.

The scope controller submits the final desired value at P0 with the same caller-owned key. `scheduleImmediate` removes a pending P1 operation with that key and transfers its waiters to the immediate commit.

This preserves the existing rule that the final interaction value cannot be lost behind a stale intermediate value.

## Generic latest-work supersession

`ScpiScheduler.scheduleLatest(priority, key, kind, execute)` keeps at most one pending latest-work operation for the same opaque key.

This is generic scheduler policy rather than waveform knowledge. The DHO804 owns a live-waveform key and uses it for live waveform acquisition at P3. A future runtime may use separate keys for different disposable/latest-value workloads without pretending those workloads are waveforms or allowing them to collide.

Different latest-work keys at the same priority remain independent. Already-running work is never cancelled by this mechanism.

## Operation kinds

`ScpiOperationKind` is deliberately a small generic metrics classification:

```ts
export enum ScpiOperationKind {
  Identity = 1,
  StateRead = 2,
  Write = 3,
  Action = 4,
  Measurement = 5,
  RawScpi = 6,
  BinaryTransfer = 7,
}
```

Instrument-specific meaning stays with the caller. For example, both live and RAW DHO804 waveform reads are `BinaryTransfer`; the shared scheduler does not need separate waveform-specific categories.

## Scope polling

The DHO804 approximately 1 Hz state validator runs individual P4 queries rather than one long exclusive operation. Higher-priority work can run between those queries. The scope controller's mutation-revision rule discards a complete snapshot if a local mutation made it stale while it was being assembled.

## Scope live waveform scheduling

The DHO804 uses a driver-owned live-waveform key with `scheduleLatest(ScpiPriority.Waveform, key, ScpiOperationKind.BinaryTransfer, ...)` for recurring live waveform reads.

One single-channel live read remains one atomic scheduled operation containing any required waveform setup, data transfer and associated metadata reads. A four-channel refresh is not one exclusive operation; each channel read returns to the scheduler separately.

## Deep/RAW scheduling

A single DHO804 RAW channel read remains one explicit P2 `BinaryTransfer` operation. Its source/mode/format/chunk/data/metadata sequence stays atomic once selected.

This means an already-started large RAW read can delay a later P0 command. That is an accepted correctness tradeoff for explicit deep capture.

## Configuration caching

Instrument-specific transport configuration caches remain in the instrument driver. For the DHO804, waveform source/mode/format/point-count caching is invalidated after reconnect or raw SCPI because those paths make the cached truth unknowable.

The scheduler does not own instrument configuration state.

## Errors and stopping

Errors fail loudly.

If an operation fails and `ScpiTransport.isUsable()` is false, the scheduler rejects all pending work with that failure. `stop()` also rejects pending work and causes future schedules to reject.

A broken SCPI transaction that leaves framing uncertain belongs to transport/session recovery; the scheduler must not guess where a later response begins.

## Instrumentation

The scheduler records:

- scheduled-operation queue wait time
- scheduled-operation duration
- binary byte count reported by the operation
- generic operation kind
- priority
- interactive coalescing count
- latest-work supersession count

These metrics identify scheduler/transport pressure without embedding instrument-domain classifications in the shared layer.

## Design rule

Responsiveness wins over processing every stale intermediate event, but response ordering and atomic multi-transaction correctness come first. Shared SCPI infrastructure owns serialization and generic scheduling policy; instrument drivers own SCPI semantics and coalescing meaning.
