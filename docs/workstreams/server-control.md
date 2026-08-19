# Server Control Implementation Workstream

## Audience

This handoff covers the server-side application/control plane after Foundation has landed.

It owns cached scope state, control semantics, state validation polling and browser WebSocket JSON transport. It does **not** own SCPI/TCP implementation, waveform acquisition/downsampling or React.

This workstream can be developed in parallel with the waveform and frontend workstreams using typed driver fakes.

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
- `docs/workstreams/scpi-backend.md`

## File ownership

Own:

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

Do not edit:

- `src/server/scpi/**`
- `src/server/scope/dho804-driver.ts`
- `src/server/waveform/**`
- `src/server/server.ts`
- `src/server/scope-runtime.ts`
- `src/web/**`
- `src/shared/**`

Final runtime composition belongs to Integration.

# Driver surface

Consume the typed DHO804 driver contract from the SCPI backend, including:

```ts
readScopeState(priority): Promise<ScopeState>;
readChannelState(channel, priority): Promise<ChannelState>;
readHorizontalState(priority): Promise<HorizontalState>;
readAcquisitionState(priority): Promise<AcquisitionState>;
readTriggerState(priority): Promise<TriggerState>;
readRunState(priority): Promise<ScopeRunState>;
```

plus focused reads/writes for each v1 control, Run/Stop/Single, measurements and raw text SCPI.

Never construct SCPI strings here.

# ScopeStateStore

Construct with one complete connected `ScopeState`:

```ts
new ScopeStateStore(initialState)
```

A suitable API is:

```ts
getState(): ScopeState;
replaceState(state: ScopeState): void;
update(updater: (state: ScopeState) => ScopeState): void;
subscribe(listener: (state: ScopeState) => void): () => void;
```

Do not represent disconnect with an optional `ScopeState`.

Treat snapshots immutably enough that subscribers can reliably observe replacement/change.

Waveform arrays never enter this store.

# ScopeController

The controller owns browser-action semantics and cached-state reconciliation.

It handles:

- `ControlSet`
- `InteractionUpdate`
- `InteractionCommit`
- Run/Stop/Single
- measurements
- raw SCPI console
- optimistic state
- focused authoritative readback
- stale-poll protection

It does not know about WebSocket objects.

## Mutation revision

Use one monotonic server-side revision:

```ts
private mutationRevision = 0;
```

Increment whenever Rigol Web performs/starts a local state-affecting action or interaction update.

A poll captures the revision before beginning. When its complete `ScopeState` returns, apply it only if the revision is unchanged.

If a local mutation happened while the P4 snapshot was being assembled, discard that whole poll result. The next approximately 1 Hz cycle will validate again.

This intentionally avoids per-property optional timestamps/conflict machinery.

# Optimistic changes

Write small explicit semantic state-update functions.

Examples:

```text
replaceChannel(...)
setChannelOffset(...)
setHorizontalPosition(...)
setEdgeTriggerLevel(...)
```

Do not use generic string property paths or `Record<string, unknown>` mutation helpers.

For a control whose new shape is already valid, update cached state immediately before/while sending the scope write.

For a structural change such as non-Edge -> Edge trigger, do **not** optimistically construct an incomplete Edge union member. Send the trigger-type write, then read a complete `TriggerState` and replace the trigger object.

# Discrete ControlSet flow

General flow:

1. validate semantic operation
2. increment mutation revision
3. optimistically update cached state where structurally valid
4. send typed driver write at Normal priority
5. perform the control's required authoritative readback group
6. update all affected cached fields from the returned scope state
7. complete request

A write may affect more than the exact property named by the browser. Read back the dependent effective state instead of waiting for the next poll where the dependency is important to the UI.

## Required dependent readback groups

### Channel enabled

Changing enabled-channel count can alter effective memory depth/sample rate.

After the write, read:

- `readChannelState(channel, Normal)`
- `readAcquisitionState(Normal)`

Update both channel and acquisition state.

### Channel scale

Changing scale can clamp/alter channel offset range, and may affect valid Edge trigger level when that channel is the trigger source.

After the write:

- read complete `ChannelState`
- if current trigger is Edge and uses this channel, read complete `TriggerState`

### Channel offset

For a discrete offset change:

- read complete `ChannelState`
- if current trigger is Edge and uses this channel, read complete `TriggerState`

This catches any dependent trigger-level clamping.

### Horizontal scale

Changing time/div can change horizontal position through the scope's expansion-reference behaviour and changes effective sample rate.

After the write, read:

- `HorizontalState`
- `AcquisitionState`

Do not assume the previous horizontal position remains authoritative.

### Horizontal position

Read focused horizontal state/position after the write.

### Trigger type

Version 1 only accepts a browser write selecting `TriggerType.Edge`.

After the write, read complete `TriggerState` because Edge requires source/slope/level/coupling.

### Trigger source

After the write, read complete `TriggerState` because changing source can change valid level/coupling/effective trigger state.

### Trigger slope

Read slope or complete `TriggerState`; no optional intermediate object.

### Trigger level

Read authoritative level after the write.

These extra reads are for discrete/final reconciliation, not every intermediate drag value.

# Interactive flow

## InteractionUpdate

For each intermediate update:

1. increment mutation revision
2. apply desired value to cached state immediately
3. call matching driver setter at `ScpiPriority.Interactive`
4. do not query the scope
5. do not await an acknowledgement before accepting later updates

The driver/scheduler owns latest-value-wins coalescing.

## InteractionCommit

For the final value:

1. increment mutation revision
2. apply final desired value optimistically
3. send setter at P0
4. perform P0 authoritative readback
5. update all dependent cached state
6. complete request

Dependent final readbacks:

- ChannelScale -> ChannelState and Edge TriggerState if source matches
- ChannelOffset -> ChannelState and Edge TriggerState if source matches
- HorizontalScale -> HorizontalState and AcquisitionState
- HorizontalPosition -> HorizontalState
- TriggerLevel -> TriggerState

The P0 final write/readback cannot be replaced by P1 intermediates.

# Edge-only controls

If `TriggerSource`, `TriggerSlope` or `TriggerLevel` arrives while authoritative trigger type is not Edge, fail clearly.

Do not silently send an Edge subcommand under another trigger type.

Frontend explicitly sends `TriggerType.Edge` first.

# Run / Stop / Single

These are actions, not assignments to `runState`.

Flow:

1. increment mutation revision
2. call typed immediate driver action
3. read `ScopeRunState` afterwards when useful
4. update cached run state

Single may move through WAIT/TD before STOP, so the approximately 1 Hz poll continues to reflect later transitions.

# Measurements

Measurements are outside `ScopeState`.

For `MeasurementRead`:

- require a non-empty request
- call driver at Background priority
- preserve requested order
- return all values or fail the whole request
- do not increment mutation revision

Measurement work must not delay interaction.

# Raw SCPI console

Pass raw command to the driver at Normal priority.

After any raw execution:

- increment mutation revision conservatively because arbitrary SCPI may change state
- do not try to parse arbitrary command text into cached-state mutations
- let the next validation cycle reconcile

A binary query is consumed safely by the SCPI transport and then rejected by the text-only v1 console, as specified by the backend/protocol docs.

# ScopePoller

Initial period: approximately 1,000 ms.

Each cycle:

1. if previous cycle is still running, skip this tick
2. capture controller mutation revision
3. `driver.readScopeState(Background)`
4. apply only if revision remains unchanged

Do not queue poll cycles.

The poller owns its timer; scheduler does not.

# WebSocket connection state

Keep disconnect lifecycle separate from `ScopeState` using a numeric union, for example:

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

Runtime/Integration swaps the current connection/session variant.

# WebSocketGateway

Own browser transport only.

Use `ws` with per-message compression disabled initially.

Responsibilities:

- accept browser clients
- send current scope lifecycle/state to new clients
- explicitly validate JSON variants
- dispatch control/measurement/SCPI requests
- dispatch deep capture/viewport through required waveform callbacks supplied by Integration
- broadcast complete `ScopeState` snapshots on store changes
- send completion/result/failure JSON
- expose binary waveform publication
- bound/replace stale waveform output under backpressure

No SCPI strings or downsampling here.

## Waveform integration seam

Accept required callbacks/interface equivalent to:

```ts
interface WaveformRequestHandlers {
  requestDeepCapture(
    requestId: number,
  ): Promise<DeepCaptureReadyMessage>;

  requestViewport(
    request: WaveformViewportRequestMessage,
  ): Promise<Uint8Array>;
}
```

and expose something equivalent to:

```ts
broadcastWaveform(frame: Uint8Array): void;
```

Do not make these optional or create a DI framework. Integration supplies real callbacks; tests supply fakes.

# JSON validation

Small explicit checks are enough; do not add a schema dependency.

Reject:

- malformed JSON
- unknown `MessageType`
- invalid request IDs
- invalid numeric enums/channels
- non-finite control numbers
- empty measurement requests
- invalid viewport ranges/pixel width

Do not construct partially valid objects.

# Request result rules

One logical result/failure for each request ID:

- ControlSet -> completion/failure
- InteractionCommit -> completion/failure
- AcquisitionAction -> completion/failure
- MeasurementRead -> MeasurementResult/failure
- ScpiExecute -> ScpiResult/failure
- DeepCaptureRequest -> DeepCaptureReady/failure
- WaveformViewportRequest -> binary frame/failure

`InteractionUpdate` has no acknowledgement.

# Multi-client behaviour

Multiple tabs share one physical scope and server state.

- broadcast state to all
- accept valid control from any
- no ownership/session locking

Last useful operation wins through normal scheduler/state semantics. This is sufficient for a personal tool.

# Binary backpressure

Never preserve stale waveform data at the expense of JSON control/state/errors.

Per client:

- bound outgoing waveform buffering
- retain newest pending live frame per channel
- discard superseded deep viewport frames
- use `ws.bufferedAmount`/send callbacks pragmatically

No custom streaming subsystem.

# Tests

Follow `testing.md`.

Required cases:

- complete store snapshots/subscriptions
- optimistic semantic updates
- stale poll revision discarded; fresh poll applied
- dependent readback groups above
- final P0 commit then readback
- non-Edge control rejection
- trigger type transition produces complete Edge state
- measurement order/failure
- raw SCPI revision invalidation
- poll cycles do not overlap
- JSON validation
- request IDs/results
- multi-client state broadcast
- binary data never enters state store
- waveform backpressure replaces stale frames

Fake typed driver methods; do not mock SCPI strings here.

# Non-goals

Do not implement:

- DHO TCP/SCPI parsing/scheduler
- waveform acquisition/downsampling/encoding
- React/Zustand/uPlot
- final runtime/startup/reconnect
- auth/session ownership

# Definition of done

Complete when:

1. state store holds only complete connected snapshots.
2. controller implements optimistic controls, P0 final reconciliation and documented dependent readbacks.
3. stale poll snapshots cannot overwrite newer local work.
4. poller is non-overlapping approximately 1 Hz background validation.
5. gateway validates/dispatches finalized JSON protocol and broadcasts full state.
6. waveform integration seam is explicit and narrow.
7. binary backpressure is bounded/latest-oriented.
8. tests pass without physical DHO804.
9. `pnpm typecheck` and `pnpm test` pass.
10. no backend/waveform/frontend ownership boundary was crossed.