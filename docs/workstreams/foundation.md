# Foundation Implementation Workstream

## Audience

This document is a self-contained implementation handoff for an engineer or coding LLM picking up the initial foundation work for Rigol Web.

The goal is to establish a small, compiling, testable project skeleton and the stable shared contracts needed for later implementation streams. Do the implementation work described here; do not redesign the application or expand into later streams.

## Project context

Rigol Web is a personal local-network web interface for one Rigol DHO804 oscilloscope.

The application is TypeScript end to end:

```text
Browser
   |
   | WebSocket
   v
Node.js server
   |
   | persistent TCP / SCPI
   v
Rigol DHO804
```

Selected stack:

- Node.js + TypeScript server
- React + TypeScript frontend
- Vite
- Zustand for application/scope state
- uPlot for waveform rendering
- one browser/server WebSocket
- one persistent server/scope TCP connection

All required software dependencies should be free/open-source. Do not introduce paid tooling, hosted services or commercial libraries.

## Read before changing code

Read these documents before implementation:

- `docs/architecture.md`
- `docs/development-practices.md`
- `docs/typescript-practices.md`
- `docs/scope-model.md`
- `docs/server-architecture.md`
- `docs/websocket-protocol.md`
- `docs/waveform-protocol.md`

Useful context that must not cause the foundation stream to implement later behaviour:

- `docs/scpi-scheduler.md`
- `docs/frontend.md`
- `docs/waveforms.md`
- `docs/testing.md`

The architecture documents are requirements, not suggestions. Do not silently replace an existing architecture decision with a different library, framework or pattern.

## Important project rules

Keep the implementation direct and easy to change.

In particular:

- filenames use lowercase kebab-case
- do not create `index.ts` barrel files or generic entrypoints
- use descriptive entrypoint names such as `server.ts`
- use actual numeric TypeScript `enum`s for fixed protocol/domain values
- assign wire-protocol enum values explicitly
- do not use string enums for protocol discriminants
- fields are required unless absence has genuine domain meaning
- prefer discriminated unions for genuinely different states
- do not make fields optional merely to make construction easier
- do not introduce a dependency-injection framework
- do not introduce a generic event bus
- do not create a generic instrument abstraction
- do not add speculative recovery infrastructure
- fail clearly when a required condition is not met

The project intentionally targets the DHO804 first. Do not generalize for other oscilloscopes during foundation work.

## Foundation objective

Create the repository skeleton and stable shared seam that lets later implementation proceed independently with low merge-conflict risk.

After this stream, later work should be able to add:

- SCPI transport/scheduler/DHO804 driver
- server state/control/WebSocket behaviour
- waveform acquisition/downsampling
- frontend controls and uPlot rendering

The foundation itself must not implement those features.

## Required source layout

Create the initial structure around these paths:

```text
src/
|- shared/
|  |- scope-types.ts
|  |- websocket-protocol.ts
|  `- waveform-protocol.ts
|
|- server/
|  `- server.ts
|
`- web/
   |- app.tsx
   |- main.tsx
   `- index.html
```

Do not create empty placeholder files for every future server class. Future streams own those files and directories.

## Tooling

Use one root package rather than creating a monorepo/workspace abstraction.

Use pnpm for package management.

Set up only the tooling needed to compile, test and run the initial server/browser shells:

- TypeScript
- Vite
- React
- Vitest
- `tsx` for running the TypeScript server in development
- Node and React type packages

Install the already-selected runtime libraries that later streams will use where doing so avoids immediate package-file contention:

- React / React DOM
- Zustand
- uPlot
- `ws`

Do not add an HTTP framework. The Node built-in HTTP server is sufficient for the foundation health endpoint.

Do not add ESLint, Prettier, a CSS framework, a component library, runtime schema framework, logging framework, DI framework or other infrastructure unless an existing repository document explicitly requires it.

Keep dependency count low.

## Root files

Create the minimum root configuration needed for the project, including:

- `package.json`
- `pnpm-lock.yaml`
- `.gitignore`
- TypeScript configuration for shared/server/browser code
- `vite.config.ts`

Use ESM consistently.

Avoid unnecessary path aliases initially. Relative imports are acceptable and make ownership obvious.

Provide scripts with clear single purposes. At minimum:

```text
pnpm dev:web
pnpm dev:server
pnpm typecheck
pnpm test
pnpm build
```

A combined development-process supervisor is not required for the foundation. Avoid adding a dependency solely to launch the web and server processes together.

## Minimal server shell

`src/server/server.ts` is only a smoke-testable server entrypoint.

It should:

- start a Node HTTP server
- expose `GET /health`
- return a simple successful response
- fail startup loudly on a genuine startup error

It should not yet:

- connect to the DHO804
- implement SCPI
- implement scheduling
- open a WebSocket server
- implement reconnect behaviour
- instantiate runtime scope state
- serve production frontend assets unless that falls out trivially from the build setup

The server shell exists to prove the Node/TypeScript build and execution path works.

## Minimal browser shell

The browser shell should prove React + Vite works without starting application feature work.

It should:

- mount one React application
- render a minimal Rigol Web placeholder/shell
- avoid real controls or visual design work

It should not yet:

- create a WebSocket client
- create a Zustand scope store
- instantiate uPlot
- implement waveform rendering
- implement drag controls
- mock large amounts of future UI

Later frontend work owns those decisions and components.

## `scope-types.ts`

Implement the shared domain types from `docs/scope-model.md`.

At minimum this includes:

- `ScopeInfo`
- `Channel`
- `ChannelCoupling`
- `ChannelUnit`
- `ChannelState`
- `ChannelStates`
- `TimebaseMode`
- `HorizontalState`
- `AcquisitionType`
- `AcquisitionState`
- `ScopeRunState`
- `TriggerType`
- `TriggerSweep`
- `EdgeSlope`
- `TriggerCoupling`
- `OtherTriggerType`
- `TriggerState`
- `ScopeState`
- `MeasurementKind`
- `MeasurementSpec`
- `MeasurementValue`

Do not implement SCPI command strings or parsing in this shared file.

Do not change the documented model merely to make construction easier. In particular, do not add `?`, `undefined`, `null`, broad strings, `unknown` payloads or generic key/value bags.

The trigger model is intentionally a discriminated union: Edge trigger has its required Edge-specific fields, while other DHO804 trigger types contain only the state version 1 actually models.

## `websocket-protocol.ts`

Implement the stable JSON protocol definitions from `docs/websocket-protocol.md`.

Stable message values:

```ts
export enum MessageType {
  ScopeConnected = 1,
  ScopeState = 2,
  ScopeDisconnected = 3,

  ControlSet = 10,
  InteractionUpdate = 11,
  InteractionCommit = 12,
  AcquisitionAction = 13,
  DeepCaptureRequest = 14,
  WaveformViewportRequest = 15,
  ScpiExecute = 16,
  MeasurementRead = 17,

  CommandCompleted = 20,
  CommandFailed = 21,
  ScpiResult = 22,
  MeasurementResult = 23,
  DeepCaptureReady = 24,
}
```

Also implement:

```ts
export enum AcquisitionAction {
  Run = 1,
  Stop = 2,
  Single = 3,
}

export enum WaveformKind {
  Live = 1,
  DeepViewport = 2,
}

export enum ControlKind {
  ChannelEnabled = 1,
  ChannelScale = 2,
  ChannelOffset = 3,
  HorizontalScale = 4,
  HorizontalPosition = 5,
  TriggerLevel = 6,
  TriggerType = 7,
  TriggerSource = 8,
  TriggerSlope = 9,
}
```

Define `PROTOCOL_VERSION = 1`.

Implement the documented shared JSON message/payload types, including:

- `ControlChange`
- `InteractiveControl`
- `ControlSetMessage`
- `InteractionUpdateMessage`
- `InteractionCommitMessage`
- `AcquisitionActionMessage`
- `MeasurementReadMessage`
- `MeasurementResultMessage`
- `DeepCaptureRequestMessage`
- `DeepCaptureChannelInfo`
- `DeepCaptureReadyMessage`
- `WaveformViewportRequestMessage`
- `ScpiExecuteMessage`
- `ScpiResultMessage`
- lifecycle messages
- command completion/failure messages
- `ClientMessage`
- `ServerJsonMessage`

Do not implement runtime WebSocket routing or validation in the foundation. These are compile-time shared contracts.

Do not use `unknown` as a generic control payload. Use the explicit discriminated unions already documented.

## `waveform-protocol.ts`

Implement the stable shared constants/enums from `docs/waveform-protocol.md`:

```ts
export const WAVEFORM_MAGIC = 0x46574752;
export const WAVEFORM_FRAME_VERSION = 1;
export const WAVEFORM_HEADER_BYTES = 64;
export const WAVEFORM_POINT_BYTES = 8;

export enum WaveformEncoding {
  IndexedFloat32 = 1,
}
```

Import/re-exporting `WaveformKind` through a barrel is not allowed. Prefer importing the existing `WaveformKind` from `websocket-protocol.ts` where needed rather than defining a second enum with duplicate ownership.

It is acceptable to define small interfaces describing decoded header/point data if they exactly match the documented fixed layout and are useful to both server and browser.

Do not implement a generic binary serialization framework.

Server encoding and browser decoding belong to later workstreams so they can be tested independently against the same fixed fixture bytes.

## Tests

Set up Vitest and include foundation-level tests that protect stable contracts.

Useful tests:

- `MessageType` values are exactly the documented integers
- `ControlKind`, `AcquisitionAction`, `WaveformKind` and `WaveformEncoding` values remain stable
- domain numeric enums used on the wire remain the documented values
- waveform magic/header/point byte constants remain exact
- `PROTOCOL_VERSION === 1`
- a server health test only if it remains small and does not require adding unnecessary HTTP test infrastructure

Do not write placeholder tests for future SCPI, scheduler, waveform service or UI functionality.

## Build outputs

Keep browser and server outputs separate, for example:

```text
dist/
|- server/
`- web/
```

Do not commit generated build output.

## Hard scope boundary

Do not implement any of the following in this workstream:

- TCP/SCPI transport
- IEEE/TMC binary-block parsing
- SCPI scheduler
- priority queues or coalescing
- DHO804 SCPI command execution or response parsing
- scope connection/initialization
- runtime scope-state reads/writes
- scope polling
- WebSocket server/client behaviour
- runtime JSON validation
- command routing
- waveform acquisition
- binary waveform frame encoding/decoding
- deep capture storage
- downsampling
- uPlot integration
- Zustand application state
- real oscilloscope controls
- reconnect/recovery machinery
- fake DHO804 server

Those are separate implementation streams.

## Avoid shared-file churn

One purpose of this stream is to create stable seams before parallel development begins.

Keep `src/shared/` deliberately small.

Do not create `utils.ts`, `types.ts`, `constants.ts` or similar dumping-ground modules.

Do not create generic catch-all types or helpers that every future stream will edit.

The shared protocol/domain model should be explicit and boring.

## Definition of done

The foundation is complete when all of the following are true:

1. A clean checkout can install dependencies with pnpm.
2. `pnpm typecheck` succeeds.
3. `pnpm test` succeeds.
4. `pnpm build` succeeds and produces separate server/web output.
5. `pnpm dev:server` starts the minimal Node server and `/health` succeeds.
6. `pnpm dev:web` starts the Vite frontend and renders the minimal Rigol Web shell.
7. `src/shared/scope-types.ts` implements the finalized domain contract without optional-field shortcuts.
8. `src/shared/websocket-protocol.ts` implements the finalized stable JSON message contract and numeric wire enums.
9. `src/shared/waveform-protocol.ts` contains the exact binary protocol constants/enums.
10. TypeScript filenames follow lowercase kebab-case and there are no `index.ts` files.
11. No SCPI, waveform-service, control-plane or real UI feature work has leaked into the foundation.
12. The diff remains small enough that later implementation streams can branch from it without inheriting unnecessary abstractions.

## Implementation behaviour for an LLM

When executing this workstream:

- inspect the current repository before changing files
- implement the work rather than returning only a plan
- preserve the architecture decisions in the docs
- keep the diff focused on foundation work
- prefer simple conventional configuration over clever tooling
- do not add optional fields to avoid making a modelling decision
- copy finalized shared semantics from the architecture docs rather than reinterpreting the Rigol manual
- run install, typecheck, tests and build before declaring completion
- report files changed and command results at the end

If there is a genuine contradiction between repository documents that blocks implementation, identify the exact conflict rather than silently choosing a new architecture.

Otherwise, make the simplest implementation consistent with the existing docs and finish the foundation.