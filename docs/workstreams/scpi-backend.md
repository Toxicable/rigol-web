# SCPI Backend Implementation Workstream

## Audience

This is the implementation handoff for the SCPI/TCP backend workstream after the foundation workstream has landed.

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

This workstream starts after foundation and may depend on:

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

Small additional files under these two owned directories are acceptable when they have a concrete single responsibility, for example a focused waveform-code decoder fixture/helper.

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

Expose a small concrete API equivalent to:

```ts
class ScpiTransport {
  connect(host: string, port: number): Promise<void>;
  disconnect(): void;

  command(command: string): Promise<void>;
  queryText(command: string): Promise<string>;
  queryBinary(command: string): Promise<Uint8Array>;
}
```

Exact method names may vary slightly, but preserve the responsibilities.

Each method represents one complete transport transaction. `queryText` is not complete until the response terminator has been consumed. `queryBinary` is not complete until the full IEEE/TMC block and its terminator have been consumed.

The scheduler is the only normal caller of these transaction methods.

### Text framing

Handle arbitrary TCP chunk boundaries. A response can arrive:

- all at once
- one byte at a time
- split around the terminator

Do not assume one Node `data` event equals one SCPI response.

### Binary framing

Support the DHO804 `#N<length><payload>` definite-length block form.

The parser must handle the header and payload split across arbitrary TCP chunks.

Return only the binary payload bytes to the caller, not the TMC header or final terminator.

Reject malformed headers and incomplete payloads clearly.

### Failure

If socket close, timeout or malformed framing makes response ownership uncertain:

- reject the active transaction
- make the transport unusable
- close the socket
- let the runtime create a new connection later

Do not attempt to scan forward for a plausible next response.

## Scheduler domain

Use actual numeric enums for fixed scheduler values.

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

Do not serialize priorities as strings.

For coalescing, use explicit semantic keys rather than arbitrary string paths:

```ts
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

The scheduler is the sole serializer of `ScpiTransport` work.

It must implement the behaviour in `scpi-scheduler.md`:

- one complete transaction at a time
- P0 through P4 priority
- FIFO within a priority unless the operation is explicitly supersedable
- latest-value-wins interactive coalescing
- no arbitrary fixed interaction-rate throttle
- live-waveform supersession
- timing metrics
- rejection of pending work when transport integrity is lost

A practical API can expose separate methods for command/text-query/binary-query scheduling, for example:

```ts
scheduleCommand(...): Promise<void>;
scheduleTextQuery(...): Promise<string>;
scheduleBinaryQuery(...): Promise<Uint8Array>;
```

The scheduling arguments must make priority and coalescing semantics explicit. Do not make every operation carry generic optional cancellation/coalescing fields.

One reasonable structure is distinct scheduled-operation variants:

- ordinary operation: required priority, no coalesce key
- interactive operation: `ScpiPriority.Interactive` plus required `ScpiCoalesceKey`
- immediate commit: `ScpiPriority.Immediate`, never discarded
- live waveform operation: `ScpiPriority.Waveform`, supersedable by freshness semantics

Do not over-generalize this into a job framework.

## Scheduler metrics

Expose enough data for the real-scope benchmark pass.

At minimum record:

- operation/transaction kind
- priority
- queue wait duration
- transport duration
- binary byte count where applicable
- number of coalesced interactive values
- number of skipped/superseded live waveform requests

A callback or small metrics sink is sufficient. Do not add a logging/telemetry framework.

## `Dho804Driver`

`Dho804Driver` is the only normal location for DHO804-specific SCPI strings and SCPI return-token parsing.

Application code calls typed methods. It does not concatenate `:CHAN`, `:TRIG`, `:WAV` strings itself.

### Identification

Implement:

```ts
identify(): Promise<ScopeInfo>
```

using `*IDN?`.

Reject any identified model other than exactly `DHO804` during initialization.

### Scope state

Implement the complete state read from `scope-model.md`:

```ts
readScopeState(priority: ScpiPriority): Promise<ScopeState>;
```

This includes:

- CH1-CH4 display/coupling/unit/scale/offset/probe ratio
- timebase mode derivation including XY quirk
- timebase scale/position
- acquisition type/averages/memory depth/sample rate
- run/trigger status
- trigger type/sweep
- Edge detail only when current trigger type is Edge

Do not populate Edge-only fields under non-Edge trigger types.

Do not batch multiple SCPI queries into semicolon command strings initially. Serialized simple queries are easier to reason about. Benchmark before changing this.

### Typed state reads/writes

Expose focused methods needed by `ScopeController` so final interaction readback does not require reading the entire scope state.

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

Each mutable write accepts a required `ScpiPriority`.

Interactive-capable writes automatically use the correct semantic coalescing key when called with `ScpiPriority.Interactive`.

An `Immediate` call for the same control is never lost through P1 coalescing.

Example conceptual signature:

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

Use the same pattern for the other interactive controls.

### Run actions

Expose typed methods for:

```text
:RUN
:STOP
:SINGle
```

These always schedule at `ScpiPriority.Immediate`.

### Measurements

Implement:

```ts
readMeasurements(
  specs: MeasurementSpec[],
  priority: ScpiPriority,
): Promise<MeasurementValue[]>;
```

Map the shared initial measurement kinds exactly as documented in `scope-model.md`.

Return results in request order.

If any individual query fails, reject the whole request rather than returning a partial array with missing entries.

### Raw SCPI console

Expose one deliberate passthrough operation such as:

```ts
executeRawScpi(command: string): Promise<string>;
```

It schedules at Normal priority.

Version 1 supports commands and text queries. A command with no response returns the empty string.

If a raw query yields a binary block, fail clearly; binary waveform reads use the typed waveform path instead.

The raw command string originates outside the driver but still passes through the scheduler.

## Waveform driver API

The waveform-service workstream must not need to know SCPI strings or native Rigol block representation.

Export a server-only normalized result type equivalent to:

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

Implement:

```ts
readLiveWaveform(
  channel: Channel,
  pointCount: number,
): Promise<Dho804Waveform>;

readRawWaveform(
  channel: Channel,
  sampleCount: number,
): Promise<Dho804Waveform>;
```

### Live waveform

`readLiveWaveform`:

- uses NORMAL mode
- validates `pointCount` in 1..1000
- schedules waveform data work at `ScpiPriority.Waveform`
- uses scheduler live-freshness supersession semantics
- returns normalized amplitude values
- obtains metadata belonging to the same waveform configuration/read
- caches repeated waveform source/mode/format/points configuration where safe

The method returns one channel. Multi-channel cycling belongs to `LiveWaveformService`.

### RAW waveform

`readRawWaveform`:

- is for a stopped scope
- represents one complete channel acquisition from source sample 0 through `sampleCount`
- schedules the explicit RAW operation above live/background work but below Immediate/Interactive work before the non-preemptible binary transaction starts
- uses WORD natively so DHO804 12-bit acquisition resolution is preserved
- may use bounded internal `STARt`/`STOP` chunks
- assembles a complete `Float32Array`
- returns X metadata and channel unit

Application code sees no native Rigol byte codes.

If any chunk fails, reject the whole channel read.

Do not issue unrelated SCPI operations between RAW chunks if that would make the capture inconsistent.

### WORD decoding verification

The manual clearly specifies two bytes per WORD point but the waveform command section available to us does not unambiguously state the required native byte ordering/signedness.

Keep native WORD decoding isolated in one function.

Implement it based on the best available DHO800 behaviour/reference, but mark the real-DHO804 cross-check from `testing.md` as required before the deep waveform path is considered hardware-verified.

Do not encode the guessed native representation into browser/shared types.

### Native conversion

Use the DHO804 waveform metadata to convert native sample codes into normalized amplitude values.

The Programming Guide demonstrates BYTE conversion as:

```text
(raw - YORigin - YREFerence) * YINCrement
```

Keep this device-specific conversion entirely inside the driver.

## Configuration caching

Waveform SCPI setup is a useful optimization.

Cache only commands such as current waveform source/mode/format/points where avoiding redundant writes saves transactions.

The cache must be invalidated when:

- transport reconnects
- a raw SCPI console command could have changed relevant waveform configuration
- another driver path explicitly changes the same configuration
- the implementation cannot know the configuration is still valid

Do not create a broad speculative cache of all scope state inside the driver. `ScopeStateStore` owns application state later.

## Tests

Follow `testing.md`.

Required focused tests include:

- arbitrary TCP chunking for text/binary responses
- binary header/payload framing failures
- all scheduler priority/coalescing cases
- live freshness supersession
- transport failure rejects pending work
- `*IDN?` parse/model rejection
- full DHO804 `ScopeState` parsing
- all trigger token mappings
- channel-unit mapping
- measurement mappings
- waveform PREamble parsing
- BYTE waveform conversion fixture
- RAW chunk assembly
- isolated WORD decoder fixture once interpretation is chosen

No real scope is required for `pnpm test`.

## Non-goals

Do not implement:

- WebSocket server
- `ScopeController`
- `ScopeStateStore`
- background poll timer
- React/Zustand
- live multi-channel looping
- deep capture IDs/storage
- server min/max downsampling
- browser binary waveform encoder/decoder
- automatic reconnect loops
- a generic instrument driver API

## Definition of done

This workstream is complete when:

1. `ScpiTransport` handles complete text and IEEE/TMC binary transactions over a persistent socket.
2. `ScpiScheduler` implements the documented P0-P4 ordering, coalescing, live supersession and metrics.
3. `Dho804Driver` implements the complete initial state/control/measurement mappings in `scope-model.md`.
4. Typed live and RAW single-channel waveform methods return normalized `Dho804Waveform` values without exposing native Rigol blocks.
5. Tests cover framing, scheduler semantics, DHO response parsing and waveform conversion boundaries.
6. `pnpm typecheck` and `pnpm test` pass.
7. No higher-layer server/UI behaviour has leaked into the SCPI backend.

Report any item that still specifically requires real-DHO804 verification, particularly native WORD decoding, rather than claiming a mock proves hardware behaviour.