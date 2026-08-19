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
- `docs/websocket-protocol.md`
- `docs/testing.md`

Use the Rigol DHO800/DHO900 Programming Guide as the device specification for command strings and response parsing.

## Dependencies

This workstream starts after Foundation and may depend on:

- `src/shared/scope-types.ts`
- stable numeric protocol/domain enums
- Vitest/tooling already configured

It must not require WebSocket, frontend or waveform-service implementations to exist.

## File ownership

Own:

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

Small extra files under those directories are acceptable only for a concrete single responsibility, such as isolated native WORD decoding.

Do not edit:

- `src/web/**`
- `src/server/waveform/**`
- `src/server/websocket/**`
- `src/server/server.ts`
- `src/server/scope/scope-controller.ts`
- `src/server/scope/scope-state-store.ts`
- `src/server/scope/scope-poller.ts`
- `src/shared/**`

If a shared contract is genuinely contradictory, report it rather than silently changing it.

# ScpiTransport

`ScpiTransport` owns the persistent TCP socket and complete response framing only.

Configure connected sockets with:

```ts
socket.setNoDelay(true);
socket.setKeepAlive(true);
```

Host/port are supplied by the caller. Do not hard-code an unverified DHO804 TCP port.

## Response model

A raw SCPI query can return text or an IEEE/TMC binary block. The transport must be able to consume either safely before deciding whether the response type was what the caller expected.

Use a server-only numeric union equivalent to:

```ts
export enum ScpiResponseKind {
  Text = 1,
  Binary = 2,
}

export type ScpiResponse =
  | {
      kind: ScpiResponseKind.Text;
      value: string;
    }
  | {
      kind: ScpiResponseKind.Binary;
      value: Uint8Array;
    };
```

A practical API is:

```ts
class ScpiTransport {
  connect(host: string, port: number): Promise<void>;
  disconnect(): void;

  command(command: string): Promise<void>;
  query(command: string): Promise<ScpiResponse>;
  queryText(command: string): Promise<string>;
  queryBinary(command: string): Promise<Uint8Array>;
}
```

`queryText`/`queryBinary` may be convenience wrappers around `query`.

If `queryText` receives a binary response, it must first consume the **entire** binary block and terminator, then reject with a response-type error. It must never scan binary bytes for a newline as though they were text.

Likewise, if `queryBinary` receives a normal text response, consume the full text line before rejecting the type mismatch.

This is required so a raw SCPI console query such as a waveform query cannot corrupt framing merely because version 1 does not expose binary console results.

Only `ScpiScheduler` invokes transport transaction methods during normal operation.

## Text framing

Handle arbitrary TCP chunk boundaries. A response may arrive in one chunk or many.

A text query is complete only after the response terminator has been consumed.

Do not assume one Node `data` event equals one response.

## Binary framing

Support the DHO804 definite-length block:

```text
#N<decimal payload length><payload><terminator>
```

Header, length digits, payload and terminator may be split across arbitrary TCP chunks.

Return only payload bytes.

Reject malformed headers/incomplete payloads clearly.

## Response detection

For a query, inspect the beginning of the actual response stream:

- a valid `#N...` definite-length header means binary
- otherwise parse a normal text response

Do not decide the parser solely from the high-level feature that issued the query.

## Failure

If close, timeout or malformed framing makes response ownership uncertain:

- reject the active transaction
- mark transport unusable
- close the socket
- let runtime create a fresh connection

Do not scan forward for a plausible next response.

# ScpiScheduler

The scheduler is the sole serializer of `ScpiTransport` access.

Use:

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

No optional `channel` field.

## Required behaviour

Implement `docs/scpi-scheduler.md`:

- P0-P4 priority
- FIFO within priority where not supersedable
- latest-value-wins P1 coalescing
- P0 commit never discarded
- live-waveform freshness supersession
- one scheduled operation at a time
- exclusive multi-transaction operations where semantic atomicity requires them
- metrics
- reject pending work when transport integrity is lost

## Scheduler API

The primitive is a scheduled operation, conceptually:

```ts
schedule<T>(operation: ScpiOperation<T>): Promise<T>;
```

The operation contains required priority/kind semantics and an executor:

```ts
execute: (transport: ScpiTransport) => Promise<T>
```

Most operations execute one transport transaction.

A live or RAW waveform operation may execute setup + data + metadata transactions while retaining exclusive scheduler ownership.

Only the scheduler supplies transport to this callback.

Convenience wrappers for ordinary command/text/binary transactions are fine.

## Atomicity

Priority is reconsidered between scheduled operations, not between transport transactions inside an already-started exclusive operation.

Use multi-transaction exclusivity for:

- one single-channel live read
- one single-channel RAW read, including internal chunks

Do **not** wrap the full approximately 1 Hz state read in one exclusive operation. Its P4 queries should yield between transactions.

## Coalescing

For a semantic P1 key:

- one value may be in flight
- at most one pending value exists
- a newer pending value replaces the old one

No arbitrary 10/20/30 Hz throttle.

## Live supersession

Do not queue multiple future P3 live reads. Retain at most one fresh-wanted indication after the current read.

## Metrics

Expose at least:

- operation kind
- priority
- queue wait
- total operation duration
- binary byte count where applicable
- coalesced interactive count
- superseded live count

No telemetry framework.

# Dho804Driver

`Dho804Driver` owns all normal DHO804-specific SCPI strings and return-token parsing.

Application layers use typed methods.

## Identification

Implement:

```ts
identify(): Promise<ScopeInfo>
```

with `*IDN?` and reject any model other than exactly `DHO804`.

## Complete state

Implement:

```ts
readScopeState(priority: ScpiPriority): Promise<ScopeState>;
```

using `scope-model.md` exactly:

- CH1-CH4 display/coupling/unit/scale/offset/probe ratio
- timebase mode including XY quirk
- horizontal scale/position
- acquisition type/averages/depth/sample rate
- run status
- trigger type/sweep
- Edge detail only for Edge trigger

Each state query is a separate short scheduled operation using the requested priority. Do not initially batch SCPI query strings.

## Focused reads/writes

Expose typed focused operations needed by the controller, including:

```ts
readChannelState(
  channel: Channel,
  priority: ScpiPriority,
): Promise<ChannelState>;

readHorizontalState(
  priority: ScpiPriority,
): Promise<HorizontalState>;

readAcquisitionState(
  priority: ScpiPriority,
): Promise<AcquisitionState>;

readTriggerState(
  priority: ScpiPriority,
): Promise<TriggerState>;

readRunState(
  priority: ScpiPriority,
): Promise<ScopeRunState>;
```

`readTriggerState` returns one complete valid union member: read type/sweep first, then Edge-only fields only when Edge.

Also expose required read/write pairs for:

```text
channel enabled
channel scale
channel offset
horizontal scale
horizontal position
trigger type
Edge source
Edge slope
Edge level
```

Every mutable write accepts required `ScpiPriority`.

P1 writes use the correct semantic coalescing key. P0 writes never disappear into P1 coalescing.

## Run actions

Typed methods for:

```text
:RUN
:STOP
:SINGle
```

always schedule at P0.

## Measurements

Implement:

```ts
readMeasurements(
  specs: MeasurementSpec[],
  priority: ScpiPriority,
): Promise<MeasurementValue[]>;
```

Map initial kinds from `scope-model.md`, preserve order and reject the whole request on any failed measurement.

Each measurement query is a separate short operation.

## Raw SCPI console

Expose one passthrough such as:

```ts
executeRawScpi(command: string): Promise<string>;
```

Rules:

- Normal priority
- one SCPI program message per execute
- if the command contains a query header (`?`), use the transport's generic response parser through the scheduler
- text response -> return it
- binary response -> consume the entire block safely, then reject because v1 console is text-only
- no-response command -> required empty string
- invalidate waveform-configuration cache after any raw execution because arbitrary SCPI may have changed it

A simple query-header detector is acceptable for v1. Do not risk leaving an unread query response in the socket.

# Normalized waveform API

Export server-only:

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

Native Rigol blocks/sample codes do not escape the driver.

## Live

```ts
readLiveWaveform(
  channel: Channel,
  pointCount: number,
): Promise<Dho804Waveform>;
```

Requirements:

- NORMAL mode
- `pointCount` 1..1000
- one exclusive P3 operation
- apply only needed waveform setup where cache is trustworthy
- DATA and associated metadata stay inside the same exclusive operation
- normalize samples to Float32 amplitude values
- use live freshness supersession

One four-channel refresh is four calls, allowing higher-priority work between channels.

## RAW

```ts
readRawWaveform(
  channel: Channel,
  sampleCount: number,
): Promise<Dho804Waveform>;
```

Requirements:

- intended for stopped scope
- one exclusive P2 operation for the complete single-channel read
- configure RAW/WORD/source/range inside it
- WORD native format preserves DHO804 12-bit resolution
- internal `STARt`/`STOP` chunks are allowed
- if chunked, all chunks remain inside the same exclusive scheduled operation
- assemble exactly `sampleCount` values
- any chunk failure rejects the whole read

Do not allow Run/raw-console/another waveform source change between chunks.

## WORD verification

The manual states two bytes per WORD sample but the waveform material used here does not unambiguously specify native byte ordering/signedness.

Isolate WORD decoding in one function. Implement from the best available DHO800 evidence, then require the real-DHO804 cross-check in `testing.md` before calling deep WORD capture hardware-verified.

Do not leak this uncertainty into the browser protocol.

## Native amplitude conversion

Use DHO waveform metadata. The Programming Guide demonstrates BYTE conversion as:

```text
(raw - YORigin - YREFerence) * YINCrement
```

Keep device-specific conversion inside the driver.

## Waveform setup cache

Cache only transfer configuration that removes redundant SCPI setup work.

Invalidate after:

- reconnect
- raw SCPI console execution
- another driver path changes relevant setup
- configuration truth is otherwise unknown

Do not create a second application `ScopeState` cache in the driver.

# Tests

Follow `testing.md`.

Required coverage includes:

- arbitrary TCP chunking for text/binary
- generic query correctly detects text versus binary
- text-expected/binary-actual consumes the full binary response before rejecting
- binary-expected/text-actual consumes the full text response before rejecting
- next query remains correctly framed after either type mismatch
- malformed binary framing fails transport
- P0-P4 ordering
- semantic coalescing
- P0 commit preservation
- exclusive operation prevents interleaving
- separate P4 state queries allow P0/P1 between them
- live supersession
- transport failure rejects pending work
- ID/model parsing
- full scope state
- channel/horizontal/acquisition/trigger/run focused reads
- trigger token mapping
- channel-unit mapping
- measurements
- PREamble parsing
- BYTE waveform conversion fixture
- RAW chunk assembly within one exclusive operation
- isolated WORD fixture once interpretation is chosen

No physical scope is required for normal tests.

# Non-goals

Do not implement:

- WebSocket server
- controller/store/poller
- React/Zustand
- multi-channel live loop
- deep capture IDs/storage/downsampling
- browser binary frames
- reconnect loop
- generic instrument framework

# Definition of done

Complete when:

1. transport safely consumes complete text or IEEE/TMC responses and type mismatches cannot desynchronize the stream.
2. scheduler implements priority/coalescing/live supersession/exclusive operations/metrics.
3. driver implements the finalized DHO804 state/control/measurement model.
4. focused state-group reads support authoritative controller reconciliation.
5. live/RAW APIs return normalized `Dho804Waveform` without native Rigol representation escaping.
6. waveform setup/data/metadata and RAW chunks remain coherent through scheduler exclusivity.
7. tests cover framing, response-type mismatch safety, scheduling and DHO parsing.
8. `pnpm typecheck` and `pnpm test` pass.
9. no higher-layer behaviour leaked into this stream.

Report real-hardware verification still required, especially native WORD decoding, rather than claiming mocks prove DHO804 behaviour.