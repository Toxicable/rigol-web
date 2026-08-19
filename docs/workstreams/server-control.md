# Server Control Implementation Workstream

## Audience

This handoff covers the server-side application/control plane after foundation has landed.

It owns cached scope state, control semantics, state validation polling and browser WebSocket JSON transport. It does **not** own SCPI/TCP implementation, waveform acquisition/downsampling or React.

This workstream can be developed in parallel with the waveform and frontend workstreams once the foundation/shared contracts exist.

## Read first

Read:

- `docs/architecture.md`
- `docs/development-practices.md`
- `docs/typescript-practices.md`
- `docs/server-architecture.md`
- `docs/scope-model.md`
- `docs/scpi-scheduler.md`
- `docs/websocket-protocol.md`
- `docs/waveform-protocol.md`
- `docs/testing.md`

Also read the public API exported by the SCPI-backend workstream if it has already landed. If developing in parallel, use the required driver surface described below and keep any temporary test fake local to this workstream.

## File ownership

This workstream owns:

```text
src/server/scope/
|- scope-state-store.ts
|- scope-state-store.test.ts
|- scope-controller.ts
|- scope-controller.test.ts
|- scope-poller.ts
`- scope-poller.test.ts

src/server/websocket/
|- websocket-gateway.ts
`- websocket-gateway.test.ts
```

It does not own:

- `src/server/scpi/**`
- `src/server/scope/dho804-driver.ts`
- `src/server/waveform/**`
- `src/server/server.ts`
- `src/server/scope-runtime.ts`
- `src/web/**`
- shared protocol/type files created by foundation

Final runtime composition belongs to the integration workstream.

## Required lower-level driver surface

This workstream expects a typed `Dho804Driver` with the capabilities defined by `docs/workstreams/scpi-backend.md`:

- read complete `ScopeState`
- focused reads/writes for each v1 control
- `readTriggerState(priority)` or equivalent focused complete trigger read
- Run/Stop/Single
- measurement reads
- raw text SCPI console

The controller must never construct DHO804 SCPI strings.

If the concrete driver method names differ slightly, adapt at import/call sites rather than adding a generic instrument abstraction.

## `ScopeStateStore`

`ScopeStateStore` owns one complete connected `ScopeState` snapshot and subscriptions to snapshot replacement.

Construct it with a complete state:

```ts
new ScopeStateStore(initialState)
```

It must never contain a half-populated scope.

A suitable API is:

```ts
getState(): ScopeState;
replaceState(state: ScopeState): void;
update(updater: (state: ScopeState) => ScopeState): void;
subscribe(listener: (state: ScopeState) => void): () => void;
```

Exact names may vary, but keep it small.

Do not make `ScopeState` optional to represent disconnect. Connection lifecycle is a different state and belongs at the runtime/gateway boundary.

The store does not query the DHO804 and contains no SCPI strings.

## Immutable snapshot behaviour

Treat `ScopeState` snapshots as replaceable values.

Avoid mutating nested channel objects in place if that makes subscribers unable to detect change reliably.

This state is small. Clarity is more important than micro-optimizing allocation here.

Waveform arrays do not enter this store.

## `ScopeController`

`ScopeController` owns application semantics between browser control messages and `Dho804Driver`.

Responsibilities:

- `ControlSet`
- `InteractionUpdate`
- `InteractionCommit`
- Run/Stop/Single
- measurement reads
- raw SCPI console
- optimistic server state
- authoritative focused readback
- protecting cached state from stale poll results

It does not know about WebSocket objects.

## State revision

Use one simple monotonic server-side mutation revision to prevent a long background poll from overwriting newer local work.

Conceptually:

```ts
private mutationRevision = 0;
```

Increment it whenever Rigol Web performs a local state-affecting action or starts/updates an interaction.

Before a poll starts, the poller records:

```ts
const revision = controller.getMutationRevision();
```

When the complete polled state returns:

```ts
controller.applyPolledState(polledState, revision);
```

Apply the snapshot only if the current mutation revision still equals the revision captured at poll start.

If any local mutation occurred while the poll was in flight, discard that entire poll result. The next approximately 1 Hz cycle will catch physical/external changes.

This is intentionally coarse. It is simpler and safer than per-property stale-poll bookkeeping, and a discarded poll cycle is cheap compared with a UI value jumping backwards.

Do not use optional per-property timestamps or a generic conflict-resolution framework.

## Discrete control flow

For `ControlSet`:

1. validate the semantic operation at the protocol/controller boundary
2. optimistically update the cached state where the new shape is already valid
3. increment mutation revision
4. issue the typed driver write at Normal priority
5. perform a focused readback where necessary to obtain the actual scope value
6. replace the corresponding cached value with authoritative readback
7. let store subscribers publish the new full snapshot

For ordinary discrete values, focused readback is preferred where it is cheap.

For structural trigger-type change to Edge, the cached `TriggerState` cannot be validly changed by setting only `type`; the Edge variant requires source/slope/level/coupling. Therefore:

- send `TriggerType.Edge`
- call `readTriggerState(Normal)` afterwards
- replace the whole trigger object with that authoritative complete Edge state

Do not temporarily construct an invalid Edge object with missing fields.

## Interactive control flow

For `InteractionUpdate`:

1. increment mutation revision
2. apply the desired value to the server cached snapshot immediately
3. invoke the corresponding driver setter at `ScpiPriority.Interactive`
4. do not query the scope after each intermediate value
5. do not wait for acknowledgement before the next update

The DHO804 driver/scheduler owns latest-value-wins coalescing.

For `InteractionCommit`:

1. increment mutation revision
2. apply the final desired value to cached state
3. send the final setter at `ScpiPriority.Immediate`
4. when that write completes, issue the focused property read at `ScpiPriority.Immediate`
5. update the cached field to the authoritative returned value
6. complete the request

The P0 final write/readback must not be replaced by an intermediate P1 value.

## Control mapping

Use the shared `ControlChange` union exactly.

Map:

- `ChannelEnabled` -> driver channel display write/read
- `ChannelScale` -> channel scale
- `ChannelOffset` -> channel offset
- `HorizontalScale` -> main timebase scale
- `HorizontalPosition` -> main timebase offset
- `TriggerLevel` -> Edge trigger level
- `TriggerType` -> version 1 accepts only `TriggerType.Edge`
- `TriggerSource` -> Edge source
- `TriggerSlope` -> Edge slope

If an Edge-only control is received while authoritative trigger type is not Edge, fail that request clearly. Do not silently send an Edge subcommand under another trigger type.

The frontend can explicitly send `TriggerType.Edge` first.

## Optimistic update helpers

Because `ScopeState` is strongly typed and nested, write small explicit update helpers rather than a generic path mutation utility.

Examples:

```text
replaceChannel(state, channel, update)
setHorizontalScale(state, value)
setTriggerLevel(edgeState, value)
```

Do not introduce `setByPath`, string property names or `Record<string, unknown>`.

## Run/Stop/Single

Acquisition actions are immediate commands.

Controller flow:

1. increment mutation revision
2. call the typed driver Run/Stop/Single action
3. read `ScopeRunState` or a small authoritative state subset after completion where useful
4. update the cached state

Do not pretend the action is a direct assignment to `runState` because Single may transition through WAIT/TD before STOP.

The approximately 1 Hz poll continues to reflect the ongoing run status.

## Measurements

`MeasurementRead` is request/response work outside `ScopeState`.

Controller:

- validates non-empty specs
- asks driver for values at Background priority
- returns the full ordered `MeasurementValue[]`
- fails the request if any measurement fails

Measurement reads should not increment state mutation revision because they do not change scope configuration.

They may be delayed behind interactive/user control work.

## Raw SCPI console

The controller passes the raw console string to `Dho804Driver.executeRawScpi` or equivalent.

After any raw SCPI execution, increment mutation revision conservatively because the command may have changed scope state.

Do not attempt to parse arbitrary console commands and manually mutate cached state. The next validation cycle will reconcile it.

Binary raw query results are rejected in version 1 as documented in `websocket-protocol.md`.

## `ScopePoller`

`ScopePoller` owns its timer.

Initial period: approximately 1,000 ms.

On each cycle:

1. if the previous cycle is still running, skip this tick
2. capture controller mutation revision
3. call `driver.readScopeState(ScpiPriority.Background)`
4. on success, call `controller.applyPolledState(state, capturedRevision)`
5. if revision changed, the result is discarded

Do not queue polls.

Do not make the scheduler aware of the timer.

The approximately 1 Hz period is a starting point, not a hard real-time requirement.

## WebSocket connection state

Do not represent disconnected state by making scope fields optional.

Use a discriminated union with a numeric enum, for example:

```ts
export enum ServerScopeConnectionKind {
  Disconnected = 1,
  Connected = 2,
}

export type ServerScopeConnection =
  | {
      kind: ServerScopeConnectionKind.Disconnected;
      reason: string;
    }
  | {
      kind: ServerScopeConnectionKind.Connected;
      info: ScopeInfo;
      stateStore: ScopeStateStore;
    };
```

The final runtime/integration workstream can set the current connection variant on the gateway.

## `WebSocketGateway`

The gateway owns browser transport only.

Use `ws`, already installed by foundation.

Responsibilities:

- accept browser WebSocket clients on the existing HTTP server
- send current connection/scope state to a newly connected browser
- validate incoming JSON structure
- dispatch control/measurement/SCPI messages to `ScopeController`
- dispatch deep-capture/viewport requests through explicit waveform callbacks supplied by integration
- send complete `ScopeState` snapshots on store changes
- send command/result/error JSON
- expose a method/callback target for binary waveform publication
- enforce outgoing waveform backpressure

It must not contain SCPI strings or downsampling.

## Waveform integration seam

The waveform workstream owns the actual services. To keep file ownership separate, the gateway accepts required explicit callbacks/interfaces rather than importing a concrete waveform service implementation during this workstream.

A suitable structural contract is conceptually:

```ts
interface WaveformRequestHandlers {
  requestDeepCapture(requestId: number): Promise<DeepCaptureReadyMessage>;
  requestViewport(request: WaveformViewportRequestMessage): Promise<Uint8Array>;
}
```

If you prefer individual constructor callbacks rather than an interface object, that is also fine.

Do not make these callbacks optional. The integration workstream supplies real implementations; tests supply small fakes.

The gateway also exposes something equivalent to:

```ts
broadcastWaveform(frame: Uint8Array): void;
```

for `LiveWaveformService` publication.

This is a narrow explicit seam, not a DI framework.

## JSON validation

Write small explicit runtime validators for the shared client message variants.

Reject:

- malformed JSON
- unknown `MessageType`
- non-integer/negative request IDs
- invalid numeric enum values
- non-finite control numbers
- invalid channel numbers
- empty measurement requests
- invalid deep viewport ranges

The validator may return a discriminated result or throw a dedicated protocol error. Do not produce partially valid objects.

Do not add Zod or another schema dependency unless there is a later concrete reason.

## Request results

Messages with `requestId` produce exactly one logical success result or failure.

Examples:

- ControlSet -> `CommandCompleted` / `CommandFailed`
- InteractionCommit -> completion/failure
- AcquisitionAction -> completion/failure
- MeasurementRead -> `MeasurementResult` / failure
- ScpiExecute -> `ScpiResult` / failure
- DeepCaptureRequest -> `DeepCaptureReady` / failure
- WaveformViewportRequest -> binary frame / failure

Intermediate `InteractionUpdate` has no acknowledgement.

## Multi-client behaviour

Keep it simple.

Multiple browser tabs may connect. There is one shared physical scope and one shared server `ScopeState`.

- broadcast authoritative state snapshots to all clients
- accept valid control commands from any connected client
- do not add ownership/session locking
- all clients see the resulting state

If two clients fight over a control, last useful operation wins through the same scope/scheduler semantics. This is acceptable for a personal tool.

## WebSocket waveform backpressure

JSON state/control/error messages must not be dropped merely to preserve old waveform frames.

For each client, keep waveform buffering bounded.

A simple implementation is sufficient:

- if a waveform write is currently backed up, retain only the newest pending live frame per channel
- retain only the newest pending deep viewport frame relevant to current requests
- when the socket has room again, send the newest retained frame
- discard superseded waveform data

Do not create an unbounded FIFO of binary frames.

Use `ws.bufferedAmount` and send completion callbacks pragmatically; do not build a custom streaming protocol.

Disable per-message compression for the WebSocket server initially.

## Tests

Follow `testing.md`.

Required cases include:

- complete state-store snapshot replacement/subscription
- optimistic updates
- stale poll revision discarded
- fresh poll applied
- final commit write then focused readback
- non-Edge control rejection
- trigger-type transition obtains complete Edge state
- measurement result order/failure semantics
- raw SCPI increments mutation revision
- poll cycles do not overlap
- JSON validation rejects bad variants
- request IDs preserved
- multiple clients receive state broadcast
- binary waveform path stays outside state store
- backpressure replaces stale waveform frames

Do not mock SCPI strings here. Fake the typed driver methods.

## Non-goals

Do not implement:

- TCP sockets to the DHO804
- SCPI response parsing
- scheduler internals
- waveform acquisition
- deep capture storage/downsampling
- waveform binary encoding
- React/Zustand/uPlot
- final server startup/composition
- automatic reconnect loops
- auth/session ownership

## Definition of done

This workstream is complete when:

1. `ScopeStateStore` holds/subscribes complete strongly typed snapshots.
2. `ScopeController` implements normal controls, optimistic interactive updates, final P0 readback semantics, measurements and raw console routing.
3. Stale background polls cannot overwrite newer local work.
4. `ScopePoller` performs non-overlapping approximately 1 Hz background validation.
5. `WebSocketGateway` validates/dispatches the complete JSON protocol and broadcasts state/results.
6. Gateway has a narrow explicit integration seam for waveform requests/publication without implementing waveform logic.
7. WebSocket waveform output is bounded/latest-oriented under backpressure.
8. Tests pass without a physical DHO804.
9. `pnpm typecheck` and `pnpm test` pass.
10. No SCPI/backend, waveform-service or frontend ownership boundaries were crossed.