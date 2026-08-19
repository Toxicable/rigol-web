# Testing Strategy

## Purpose

Rigol Web needs confidence in three areas that fail differently:

- pure application logic
- serialized SCPI/TCP behaviour
- actual DHO804 behaviour and performance

Do not solve this with one giant fake oscilloscope or a heavy end-to-end test framework.

Use small tests at the layer where the behaviour belongs, plus a deliberate real-scope verification pass for device-specific facts that cannot be proven from mocks.

All test tooling should remain free/open-source. The selected test runner is Vitest.

## Test layers

Use four layers:

1. pure unit tests
2. deterministic component tests with small fakes
3. TCP/WebSocket integration tests where framing matters
4. explicit real-DHO804 bench tests and benchmarks

The real DHO804 is not required for the normal unit test suite.

## Pure unit tests

Pure functions should be tested without sockets, timers or browser automation.

High-value examples:

- SCPI discrete response parsing
- numeric response parsing and rejection of malformed/non-finite values
- trigger/status enum mapping
- channel-unit mapping
- measurement-kind to SCPI-item mapping
- deep min/max downsampling
- overscan range calculation
- waveform binary frame encode/decode
- zero-based/one-based waveform sample-index conversion
- protocol validation helpers

Do not test trivial TypeScript getters merely to increase coverage numbers.

## SCPI transport tests

`ScpiTransport` owns stream framing, so test it against a tiny local TCP peer rather than mocking every socket method.

The local peer only needs enough behaviour to feed exact byte sequences.

Test at least:

- text response arriving in one TCP chunk
- text response split across multiple chunks
- multiple network chunks coalesced by Node before the parser sees them
- IEEE/TMC binary block header split across chunks
- binary payload split across many chunks
- terminator arriving separately from the payload
- zero/invalid header digits rejected
- declared payload length not fully received before timeout/close
- socket closes mid-text response
- socket closes mid-binary response
- no later transaction consumes bytes from an earlier response

The transport fake does not need to understand channels, trigger settings or waveform meaning.

## Scheduler tests

The scheduler is important enough to test independently from TCP and the DHO804 driver.

Use a deterministic fake transaction executor that lets a test hold an operation in flight and explicitly complete it.

Test the behaviour documented in `scpi-scheduler.md`:

### Priority

Given queued P4, P3, P2, P1 and P0 work, the next unstarted operation is selected by priority.

An operation already in flight is allowed to finish; do not pretend the scheduler can interrupt bytes already being exchanged with the scope.

### Latest-value-wins

Example:

```text
CH1 offset 0.100 starts
0.105 queued
0.110 replaces 0.105
0.125 replaces 0.110
```

After the in-flight operation completes, the next CH1 offset write must be `0.125`, not a replay of all intermediate values.

### Independent coalescing keys

CH1 offset and CH2 offset must not overwrite each other.

Trigger level and horizontal position must not share a coalescing slot.

### Commit priority

A final interaction commit:

- is not lost behind an intermediate value
- runs at P0 after the current transaction
- is followed by its authoritative readback in the expected controller flow

### Waveform supersession

Many fresh-waveform requests arriving during one live read produce at most one subsequent read, not a FIFO backlog.

### Failure

When the transport becomes unusable, pending scheduler work is rejected and stale operations are not replayed after a replacement transport appears.

### Metrics

Where timing instrumentation is exposed as data, test counters/durations structurally without asserting fragile wall-clock millisecond values.

## DHO804 driver tests

The driver owns SCPI semantics and parsing.

Use a small scripted scheduler/transport boundary that records the submitted SCPI transaction and returns an exact configured response.

Driver tests should assert both directions:

- the expected command is generated
- the response is parsed into the documented domain type

Cover the initial `ScopeState` mapping from `scope-model.md`, including:

- four channels
- channel coupling/unit/scale/offset/probe ratio
- MAIN/ROLL/XY mode derivation
- acquisition type/averages/depth/sample rate
- run state
- all DHO804 trigger-type return tokens
- Edge source/slope/level/coupling
- malformed/unknown tokens fail clearly
- `*IDN?` rejects a non-DHO804 model during initialization

Do not build a generic SCPI simulator for these tests. A scripted sequence is clearer.

## DHO804 waveform driver tests

Native waveform framing and native code conversion deserve focused tests.

Use captured/synthetic TMC blocks and known metadata to test:

- NORMAL BYTE conversion using the Programming Guide formula
- PREamble parsing
- sample index conversion
- chunked RAW assembly
- exact sample count validation
- conversion into normalized amplitude values

Native WORD decoding is a special verification item because the Programming Guide section in use states two bytes per point but does not clearly specify the byte ordering/signedness needed for a complete implementation.

Isolate WORD decoding in one function. Add tests once the real DHO804 behaviour is bench-verified and record the chosen interpretation in the test fixtures/comments.

Do not let guessed WORD behaviour spread through multiple files.

## State store and controller tests

Test application semantics without WebSocket transport.

Important cases:

- complete authoritative snapshot replacement
- optimistic interactive value application
- background poll update for unrelated properties during an interaction
- stale poll value for the active property does not overwrite the optimistic value
- interaction commit sends final value then applies authoritative readback
- discrete control applies the driver result/readback policy
- Run/Stop/Single call the correct driver action
- Edge-only controls reject or first establish Edge trigger as specified rather than sending nonsensical commands under another trigger type

Use real shared `ScopeState` objects with every required field populated. Do not create optional-field test shortcuts.

## Poller tests

Use fake timers.

Test:

- approximately one cycle is scheduled per configured period
- a new cycle does not pile up while the previous cycle is still running
- stopping the poller prevents future cycles
- poll work enters the driver/scheduler at background priority

Do not assert exact wall-clock scheduling beyond what is useful.

## Waveform service tests

### Live service

Test:

- only enabled channels are requested
- each channel read is a separate scheduler opportunity
- at most one acquisition is active
- repeated fresh requests collapse
- stale frames are replaceable

### Deep capture

Test:

- capture requires stopped state or performs the explicitly designed stop flow
- selected enabled channels are captured
- a failure before all channels complete does not publish a partial new capture
- previous completed capture survives a failed replacement capture
- successful replacement invalidates the previous capture ID
- only the latest completed capture is retained in version 1

### Downsampling

Use signals designed to catch bad decimators:

- single-sample positive glitch inside a large bucket
- single-sample negative glitch
- min before max
- max before min
- equal min/max source point
- constant waveform
- monotonic ramp
- requested range smaller than pixel width
- range exactly on capture boundaries

The tests should prove narrow extrema survive.

## Waveform protocol tests

`waveform-protocol.md` defines an exact 64-byte header and 8-byte point records.

Test a known fixture byte-for-byte.

Cover:

- magic
- version
- little-endian integer fields
- Float64 X metadata
- channel unit
- indexed Float32 point payload
- exact frame-length validation
- invalid point index outside represented range
- unknown encoding/version rejection

Server encoder and browser decoder should share constants, not share one implementation that makes a matching bug invisible on both sides.

A good pattern is:

- server encoder test against fixed bytes
- browser decoder test against the same fixed bytes

## WebSocket gateway tests

Use an in-process WebSocket server/client where transport behaviour matters.

Test:

- valid JSON message decoding
- malformed JSON rejected
- unknown numeric message type rejected
- invalid enum/control payload rejected
- request ID preserved in completion/failure
- state snapshots sent as complete state
- measurement request/result ordering
- deep-capture ready response
- binary frames delivered separately from JSON
- waveform backpressure replacement behaviour

Do not test DHO804 SCPI strings through the gateway. That belongs to driver tests.

## Frontend tests

Keep frontend tests focused on state/interaction logic rather than pixel-perfect DOM snapshots.

Useful cases:

- connected/disconnected state is represented by a discriminated union
- complete authoritative scope snapshot replaces the previous authoritative snapshot
- active interactive value stays visually optimistic until commit/readback
- interaction update sends no request ID/ack dependency
- interaction commit uses a request ID
- binary waveform decode bypasses Zustand scope state
- stale live sequence is ignored
- stale deep viewport response is ignored when a newer viewport is desired
- overscan cache answers a small pan locally

Do not introduce a browser automation dependency solely for version 1 unless manual integration reveals behaviour that cannot be covered economically otherwise.

## Minimal fake DHO804 TCP peer

A small fake TCP peer is useful for integration, but keep it intentionally limited.

It may support only commands required by a specific test scenario, for example:

- `*IDN?`
- a handful of state queries
- one text query
- one binary waveform query

Its purpose is to exercise the real `ScpiTransport` and scheduler over TCP.

It is not a second implementation of the DHO804.

When a test needs a new response, add the minimum scripted behaviour rather than building a generic command parser.

## Real DHO804 verification

Some facts must be checked on the actual scope before calling the corresponding path finished.

Record the scope firmware version from `*IDN?` with benchmark results.

Verify at least:

- raw TCP port/connection behaviour used by the implementation
- command terminator behaviour
- `TCP_NODELAY` path behaves normally
- all initial state queries and return tokens
- physical control changes appear through the approximately 1 Hz validator
- continuous offset/trigger/horizontal writes and final readback
- live NORMAL waveform points and metadata
- native WORD sample byte ordering/signedness
- WORD conversion against a known signal and/or BYTE/ASCII comparison
- RAW read behaviour while stopped
- expected failure/refusal if RAW is attempted while running
- large RAW transfers at representative memory depths
- multi-channel RAW capture consistency

Do not paper over a discrepancy by weakening parsers to accept arbitrary data. Update the documented DHO804-specific mapping when the actual scope proves the manual/assumption wrong.

## Performance benchmark pass

Responsiveness is a primary requirement, so benchmark the real scope deliberately.

At minimum collect:

### Command latency

- simple write latency
- simple text-query round trip
- channel offset write/readback
- trigger level write/readback
- horizontal position write/readback

### Interactive throughput

Generate continuous desired values faster than the scope can consume and measure:

- useful writes/second reaching the scope
- coalesced values count
- worst/median queue wait for P1
- final P0 commit latency

The goal is not to preserve every input event. The goal is low final/current-state latency.

### Live waveform

Measure by enabled-channel count:

- points per NORMAL read
- bytes transferred
- query latency
- useful frames/second per channel
- interaction latency while live streaming

Test at least 1, 2 and 4 enabled channels.

### Deep waveform

Measure representative RAW sizes where available:

- 1 kpts
- 100 kpts
- 1 Mpts
- 5 Mpts
- 10 Mpts
- 25 Mpts in a valid single-channel configuration

Record:

- transfer bytes
- transfer duration
- conversion duration
- total capture duration
- Node memory used by normalized capture

### Viewport generation

For a 1,600 px viewport, benchmark min/max generation over representative visible source ranges such as:

- 25 k samples
- 2.5 M samples
- 25 M samples

Only add a multiresolution cache if these measurements justify it.

## Benchmark output

Do not build a telemetry platform.

A simple development command or script that prints structured timing rows/JSON is enough.

Benchmark results should include:

- date
- DHO804 firmware version
- connection type
- operation
- point/byte count where applicable
- median
- p95 where enough samples exist
- notes on channel count/memory depth

Keep one representative result file under `docs/benchmarks/` only when actual measurements exist. Do not commit invented placeholder numbers.

## CI expectations

Normal CI/local verification should run without a scope:

```text
pnpm typecheck
pnpm test
pnpm build
```

Real-scope tests are explicit/manual bench tests and must not make ordinary test runs hang waiting for hardware.

If a real-scope test command is added, give it a separate descriptive script such as:

```text
pnpm test:scope
pnpm benchmark:scope
```

Do not make missing hardware look like a unit-test failure.

## Failure philosophy in tests

Prefer tests that prove invalid data is rejected clearly.

Do not add broad catch-and-ignore paths merely so tests pass.

The application's failure philosophy is the same in tests as in production: if SCPI framing or required domain state is invalid, fail loudly at the boundary that owns it.
