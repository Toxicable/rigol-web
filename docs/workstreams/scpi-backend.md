# SCPI Backend Implementation Workstream

## Audience

This is the implementation handoff for the SCPI/TCP backend workstream after Foundation has landed.

Implement the transport, scheduler and DHO804 semantic driver. Do not build WebSocket/application UI behaviour or deep-capture downsampling here.

## Read first

Read:

- `docs/architecture.md`
- `docs/development-practices.md`
- `docs/typescript-practices.md`
- `docs/server-architecture.md`
- `docs/scpi-scheduler.md`
- `docs/scope-model.md`
- `docs/waveforms.md`
- `docs/testing.md`

Use the Rigol DHO800/DHO900 Programming Guide as the device specification when implementing command strings and response parsing.

## Dependencies

This workstream starts after Foundation and may depend on:

- `src/shared/scope-types.ts`
- stable protocol/domain numeric enums
- Vitest/tooling already configured

It must not require the WebSocket, frontend or waveform-service workstreams to exist.

## File ownership

This workstream owns:

```text
src/server/scpi/
|- scpi-transport.ts
|- scpi-transport.test.ts
|- scpi-scheduler.ts
`- scpi-scheduler.test.ts

src/server/scope/
|- dho804-driver.ts
`- dho804-driver.test.ts
```

Small additional files under these two owned directories are acceptable when they have a concrete single responsibility, for example a focused native waveform decoder.

Do not edit:

- `src/web/**`
- `src/server/waveform/**`
- `src/server/websocket/**`
- `src/server/server.ts`
- `src/server/scope/scope-controller.ts`
- `src/server/scope/scope-state-store.ts`
- `src/server/scope/scope-poller.ts`

Do not change shared protocol/domain contracts unless there is a genuine contradiction in the architecture docs. If one exists, report it rather than silently reshaping the shared types.

## `ScpiTransport`

`ScpiTransport` owns the persistent TCP socket and response framing only.

Configure connected sockets with:

```ts
socket.setNoDelay(true);
socket.setKeepAlive(true);
```

The scope host/port are supplied by the caller. Do not hard-code an unverified DHO804 TCP port into this layer.

Expose a small concrete transaction API equivalent to:

```ts
class ScpiTransport {
  connect(host: string, port: number): Promise<void>;
  disconnect(): void;

  command(command: string): Promise<void>;
  queryText(command: string): Promise<string>;
  queryBinary(command: string): Promise<Uint8Array>;
}
```

Only `ScpiScheduler` invokes these transaction methods during normal operation.

A text query is not complete until its response terminator has been consumed. A binary query is not complete until the full IEEE/TMC block and its terminator have been consumed.

### Text framing

Handle arbitrary TCP chunk boundaries. A response can arrive:

- all at once
- one byte at a time
- split around the terminator

Do not assume one Node `data` event equals one SCPI response.

### Binary framing

Support the DHO804 `#N<length><payload>` definite-length block form.

The parser must handle header/payload/terminator split across arbitrary TCP chunks.

Return only the binary payload bytes to the caller.

Reject malformed headers and incomplete payloads clearly.

### Failure

If socket close, timeout or malformed framing makes response ownership uncertain:

- reject the active transaction
- make the transport unusable
- close the socket
- let runtime create a fresh connection later

Do not scan forward for a plausible next response.

## Scheduler domain

Use numeric enums:

```ts
export enum ScpiPriority {
  Immediate = 0,
  Interactive = 1,
  Normal = 2,
  Waveform = 3,
  Background = 4,
}

export enum ScpiCoalesceKind {
  ChannelScale = 1,
  ChannelOffset = 2,
  HorizontalScale = 3,
  HorizontalPosition = 4,
  TriggerLevel = 5,
}

export type ScpiCoalesceKey =
  | {
      kind: ScpiCoalesceKind.ChannelScale | ScpiCoalesceKind.ChannelOffset;
      channel: Channel;
    }
  | {
      kind:
        | ScpiCoalesceKind.HorizontalScale
        | ScpiCoalesceKind.HorizontalPosition
        | ScpiCoalesceKind.TriggerLevel;
    };
```

Do not add optional `channel` merely because some kinds do not use one.

## `ScpiScheduler`

The scheduler is the sole serializer of `ScpiTransport` access.

It must implement `docs/scpi-scheduler.md`:

- P0 through P4 priority
- FIFO within priority where not supersedable
- latest-value-wins P1 coalescing
- P0 interaction commits never discarded
- live-waveform freshness supersession
- one scheduled operation at a time
- support for a small number of exclusive multi-transaction operations
- metrics
- pending-work rejection when transport integrity is lost

### Scheduler API

The important abstraction is a scheduled **operation**, not merely a queue of command strings.

A practical API is equivalent to:

```ts
schedule<T>(operation: ScpiOperation<T>): Promise<T>;
```

where an operation supplies required priority/kind semantics and an executor that receives transport access only while the operation owns the scheduler:

```ts
execute: (transport: ScpiTransport) => Promise<T>
```

Most operations execute one transport transaction.

Waveform operations may execute several transport transactions atomically, for example setup + DATA query + PREamble/metadata.

Do not expose `ScpiTransport` outside the scheduler callback.

You may add convenience methods such as `scheduleCommand`/`scheduleTextQuery` around this primitive, but the exclusive callback capability is required.

### Atomicity

Priority is reconsidered between scheduled operations.

Once an exclusive operation begins, P0 cannot interrupt its internal transport transactions.

Use this only where stable DHO804 configuration is semantically required:

- one live single-channel waveform read
- one RAW single-channel read, including internal chunks if used

Do **not** make the full approximately 1 Hz state poll one exclusive operation. Its individual P4 queries must yield to interaction.

### Coalescing

For each semantic interactive key:

- one value may be in flight
- at most one pending value exists
- a newer pending value replaces the older one

Do not add a fixed-rate throttle.

### Live supersession

Do not queue a FIFO of P3 live reads. Retain at most one indication that a fresh live waveform is wanted after the current one.

### Metrics

Expose at least:

- operation kind
- priority
- queue wait duration
- total operation duration
- binary byte count where applicable
- coalesced interactive count
- superseded live-request count

A callback/small sink is enough. No logging framework.

## `Dho804Driver`

`Dho804Driver` is the only normal location for DHO804 SCPI strings and return-token parsing.

Application code calls typed methods and never constructs `:CHAN`, `:TRIG`, `:WAV` commands itself.

## Identification

Implement:

```ts
identify(): Promise<ScopeInfo>
```

using `*IDN?`.

Reject any model other than exactly `DHO804` during initialization.

## Complete scope state

Implement:

```ts
readScopeState(priority: ScpiPriority): Promise<ScopeState>;
```

using the exact mapping in `scope-model.md`.

This includes:

- CH1-CH4 display/coupling/unit/scale/offset/probe ratio
- timebase mode including XY derivation quirk
- timebase scale/position
- acquisition type/averages/memory depth/sample rate
- run status
- trigger type/sweep
- Edge details only when current trigger type is Edge

Each query in the full state read is a separate short scheduled operation using the requested priority. This allows P0/P1 work between P4 poll queries.

Do not batch semicolon-separated SCPI queries initially. Benchmark before changing this.

## Focused reads/writes

Expose focused methods for controller use so final interaction readback does not require a complete state read.

Required write/read pairs:

```text
channel enabled
channel scale
channel offset
horizontal scale
horizontal position
trigger type
Edge trigger source
Edge trigger slope
Edge trigger level
```

Also expose:

```ts
readTriggerState(priority: ScpiPriority): Promise<TriggerState>;
readRunState(priority: ScpiPriority): Promise<ScopeRunState>;
```

`readTriggerState` first reads trigger type/sweep and only reads Edge-specific fields when the type is Edge. It returns one complete valid `TriggerState` union member.

Each mutable write accepts a required `ScpiPriority`.

Interactive-capable writes use the correct semantic coalescing key when called with `ScpiPriority.Interactive`.

An `Immediate` call for the same control is never lost through P1 coalescing.

Example:

```ts
setChannelOffset(
  channel: Channel,
  value: number,
  priority: ScpiPriority,
): Promise<void>;

readChannelOffset(
  channel: Channel,
  priority: ScpiPriority,
): Promise<number>;
```

Use the same pattern for other focused controls.

## Run actions

Expose typed methods for:

```text
:RUN
:STOP
:SINGle
```

They always schedule at `ScpiPriority.Immediate`.

## Measurements

Implement:

```ts
readMeasurements(
  specs: MeasurementSpec[],
  priority: ScpiPriority,
): Promise<MeasurementValue[]>;
```

Map the initial kinds exactly from `scope-model.md` and return in request order.

Each measurement query is its own short scheduled operation so interaction can run between measurement reads.

If any query fails, reject the whole request rather than returning missing/optional values.

## Raw SCPI console

Expose one deliberate passthrough such as:

```ts
executeRawScpi(command: string): Promise<string>;
```

Schedule it at Normal priority.

Version 1 supports commands and text queries. No-response commands return the required empty string.

Reject binary raw-query results clearly. Typed waveform operations own binary acquisition.

Because arbitrary raw SCPI may alter waveform configuration, invalidate the driver's waveform-configuration cache after execution.

## Normalized waveform result

Export a server-only result equivalent to:

```ts
export interface Dho804Waveform {
  channel: Channel;
  unit: ChannelUnit;
  samples: Float32Array;
  xIncrement: number;
  xOrigin: number;
  xReference: number;
}
```

Native Rigol waveform representation must not escape this driver boundary.

## Live waveform

Implement:

```ts
readLiveWaveform(
  channel: Channel,
  pointCount: number,
): Promise<Dho804Waveform>;
```

Requirements:

- NORMAL mode
- `pointCount` 1..1000
- one exclusive P3 scheduled operation
- setup source/mode/format/points only where cache says needed
- query data and associated metadata inside that same operation
- normalize native samples to Float32 amplitude values
- return X metadata/unit
- use live freshness supersession semantics

A four-channel cycle is four separate calls, not one exclusive operation.

## RAW waveform

Implement:

```ts
readRawWaveform(
  channel: Channel,
  sampleCount: number,
): Promise<Dho804Waveform>;
```

Requirements:

- caller is expected to have a stopped scope
- one exclusive P2 scheduled operation for the whole single-channel RAW read
- configure RAW/WORD/source/range inside that operation
- WORD native format to preserve DHO804 12-bit acquisition resolution
- may use bounded `STARt`/`STOP` chunks internally
- if chunked, every chunk remains inside the same exclusive operation
- assemble exactly `sampleCount` normalized amplitude values
- return X metadata/unit
- any chunk failure rejects the whole read

Do not allow Run, raw console or another waveform source change to interleave between RAW chunks.

The explicit deep-capture workflow accepts that an already-started large RAW channel read cannot be preempted by a later P0 command.

## Native WORD verification

The manual states two bytes per WORD point but the waveform section available to this project does not unambiguously specify byte ordering/signedness.

Keep native WORD decoding isolated in one function.

Implement from the best available DHO800 behaviour/reference, but mark real-DHO804 cross-check from `testing.md` as required before declaring deep WORD hardware-verified.

Do not encode native WORD assumptions in shared/browser types.

## Native amplitude conversion

Use DHO waveform metadata to convert native codes to normalized amplitude values.

The Programming Guide demonstrates BYTE conversion as:

```text
(raw - YORigin - YREFerence) * YINCrement
```

Keep this device-specific conversion entirely inside the driver.

## Waveform configuration caching

Cache only transport-relevant waveform setup where it avoids redundant commands, such as source/mode/format/points.

Invalidate when:

- transport reconnects
- raw SCPI console executes
- another driver path changes the same setup
- configuration truth is otherwise unknown

Do not create a second broad cache of application `ScopeState` inside the driver.

## Tests

Follow `testing.md`.

Required cases include:

- arbitrary TCP chunking for text/binary responses
- binary header/payload framing failures
- P0-P4 scheduler ordering
- coalescing and independent semantic keys
- final P0 commit preservation
- exclusive operation prevents interleaving
- poll-style short P4 operations allow P0/P1 between them
- live freshness supersession
- transport failure rejects pending work
- DHO804 ID parsing/model rejection
- complete scope-state parsing
- complete `readTriggerState` for Edge and non-Edge
- all trigger token mappings
- channel-unit mapping
- measurement mapping/order
- PREamble parsing
- BYTE waveform conversion fixture
- RAW chunk assembly inside one exclusive operation
- isolated WORD decoder fixture once interpretation is chosen

No physical scope is required for `pnpm test`.

## Non-goals

Do not implement:

- WebSocket server
- `ScopeController`
- `ScopeStateStore`
- background poll timer
- React/Zustand
- live multi-channel loop
- deep capture IDs/storage
- server min/max downsampling
- browser binary encoding/decoding
- reconnect loop
- generic instrument API

## Definition of done

This workstream is complete when:

1. `ScpiTransport` handles complete text and IEEE/TMC binary transactions over a persistent socket.
2. `ScpiScheduler` implements documented priorities, coalescing, live supersession, exclusive multi-transaction operations and metrics.
3. `Dho804Driver` implements complete initial state/control/measurement mappings.
4. Focused controller reads include complete `readTriggerState` and run-state readback.
5. Typed live and RAW waveform methods return normalized `Dho804Waveform` values without exposing native Rigol blocks.
6. Live setup/data/metadata and RAW setup/chunks/metadata remain coherent through scheduler atomicity.
7. Tests cover framing, scheduler semantics, DHO parsing and waveform conversion boundaries.
8. `pnpm typecheck` and `pnpm test` pass.
9. No higher-layer server/UI behaviour leaked into the backend.

Report any item that still specifically requires real-DHO804 verification, particularly native WORD decoding, rather than claiming mocks prove hardware behaviour.