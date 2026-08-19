# Foundation Implementation Workstream

## Audience

This document is a self-contained implementation handoff for an engineer or coding LLM picking up the initial foundation work for Rigol Web.

The goal is to establish a small, compiling, testable project skeleton and the minimum stable shared contracts needed for later implementation streams. Do the implementation work described here; do not redesign the application or expand into later streams.

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

The selected application stack is:

- Node.js + TypeScript server
- React + TypeScript frontend
- Vite
- Zustand for application/scope state
- uPlot for waveform rendering
- one browser/server WebSocket
- one persistent server/scope TCP connection

All required software dependencies should be free/open-source. Do not introduce paid tooling, hosted services or commercial libraries.

The repository currently contains architecture documentation but no application code or package/tooling setup.

## Read before changing code

Read these documents before implementation:

- `docs/architecture.md`
- `docs/development-practices.md`
- `docs/typescript-practices.md`
- `docs/server-architecture.md`
- `docs/websocket-protocol.md`

The following are useful context but should not cause the foundation stream to implement their behaviour:

- `docs/scpi-scheduler.md`
- `docs/frontend.md`
- `docs/waveforms.md`

The architecture documents are requirements, not suggestions. If a detail is not decided there, prefer the simplest implementation that leaves the later stream free to make the real decision.

Do not silently replace an existing architecture decision with a different library, framework or pattern.

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
- do not make fields optional just to make construction easier
- do not introduce a dependency-injection framework
- do not introduce a generic event bus
- do not create a generic instrument abstraction
- do not add speculative recovery infrastructure
- fail clearly when a required condition is not met

The project intentionally targets the DHO804 first. Do not generalize for other oscilloscopes during foundation work.

## Foundation objective

Create the repository skeleton and minimum shared seam that lets later implementation proceed in parallel with low merge-conflict risk.

After this stream, later work should be able to independently add:

- SCPI transport/scheduler/DHO804 driver
- server runtime/controller/WebSocket behaviour
- waveform acquisition/downsampling
- frontend controls and uPlot rendering

The foundation itself must not implement those features.

## Required source layout

Create the initial structure around these paths:

```text
src/
|- shared/
|  |- scope-types.ts
|  `- websocket-protocol.ts
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

Git does not require empty directories to exist ahead of time.

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

Provide scripts with clear single purposes. At minimum the repository should support equivalents of:

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
- contain scope state
- serve production frontend assets unless that falls out trivially from the chosen build setup

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

Later frontend streams own those decisions and components.

## Shared types

The foundation owns only the minimum stable shared vocabulary needed to establish compile-time seams.

### `scope-types.ts`

Define only domain types whose meaning is already unambiguous from the architecture.

At minimum this should include stable primitives such as the DHO804 channel identity:

```ts
export enum Channel {
  Ch1 = 1,
  Ch2 = 2,
  Ch3 = 3,
  Ch4 = 4,
}
```

Do not invent detailed trigger/acquisition/channel semantics that require SCPI manual research which belongs to the DHO804/state-model implementation work.

Do not make a speculative giant `ScopeState` simply to appear complete. If the complete `ScopeState` has not yet been specified by the architecture, keep the foundation vocabulary intentionally small and let the appropriate later stream extend it.

Most importantly, do not hide undecided modelling behind `?`, `undefined`, `null`, `unknown`, broad string dictionaries or generic key/value bags.

### `websocket-protocol.ts`

Establish the stable numeric protocol enums already documented in `docs/websocket-protocol.md`.

The currently documented message values are:

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

  CommandCompleted = 20,
  CommandFailed = 21,
  ScpiResult = 22,
}
```

Also establish the documented fixed enums whose values are already decided, including:

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
```

`ControlKind` may contain the currently documented values, but do not invent additional control kinds during foundation work.

Where a full message interface depends on an unsettled detailed domain model, do not invent the model merely so every conceptual protocol message can be represented on day one. Establish the stable enums and only concrete message types whose payload types are already well-defined.

The later state/control implementation stream can expand the shared contract deliberately.

## Protocol version

Define one explicit integer protocol version in shared code. Version `1` is appropriate for the initial implementation.

Do not implement negotiation or compatibility machinery. A later WebSocket stream can fail clearly when versions differ.

## Tests

Set up Vitest and include a small number of foundation-level tests that provide actual value.

Useful tests include:

- protocol enum values are the documented stable integers
- simple shared helper behaviour, if any exists
- a server health test only if it remains small and does not require introducing a test framework around HTTP

Do not write placeholder tests for future SCPI, scheduler, waveform or UI functionality.

The purpose here is to prove the test toolchain works, not to create fake coverage.

## Build outputs

Keep browser and server outputs separate, for example:

```text
dist/
|- server/
`- web/
```

Do not commit generated build output.

The exact TypeScript/Vite configuration may differ if needed, but preserve the separation and keep the build understandable.

## Hard scope boundary

Do not implement any of the following in this workstream:

- TCP/SCPI transport
- IEEE binary-block parsing
- SCPI scheduler
- priority queues or coalescing
- DHO804 SCPI commands
- scope discovery
- full `ScopeState` mapping
- scope polling
- WebSocket server/client behaviour
- command routing
- waveform acquisition
- waveform binary framing
- deep capture storage
- downsampling
- uPlot integration
- Zustand application state
- real oscilloscope controls
- reconnect/recovery machinery
- fake DHO804 server

Those are separate implementation streams.

If you find yourself needing one of these to complete the foundation, stop and reassess whether the foundation has grown beyond its purpose.

## Avoid shared-file churn

One purpose of this stream is to create stable seams before parallel development begins.

Keep `src/shared/` deliberately small.

Do not create generic catch-all types or helpers that every future stream will edit. Prefer specific files owned by future streams over central utility files.

Do not create `utils.ts`, `types.ts`, `constants.ts` or similar dumping-ground modules.

The initial shared protocol values should be explicit and boring.

## Definition of done

The foundation is complete when all of the following are true:

1. A clean checkout can install dependencies with pnpm.
2. `pnpm typecheck` succeeds.
3. `pnpm test` succeeds.
4. `pnpm build` succeeds and produces separate server/web output.
5. `pnpm dev:server` starts the minimal Node server and `/health` succeeds.
6. `pnpm dev:web` starts the Vite frontend and renders the minimal Rigol Web shell.
7. Stable documented protocol enums use actual numeric TypeScript enums with explicit wire values.
8. TypeScript filenames follow lowercase kebab-case and there are no `index.ts` files.
9. No SCPI, waveform, control-plane or real UI feature work has leaked into the foundation.
10. The diff remains small enough that the later implementation streams can branch from it without inheriting unnecessary abstractions.

## Implementation behaviour for an LLM

When executing this workstream:

- inspect the current repository before changing files
- implement the work rather than returning only a plan
- preserve the architecture decisions in the docs
- keep the diff focused on foundation work
- prefer simple conventional configuration over clever tooling
- do not add optional fields to avoid making a modelling decision
- do not guess at DHO804-specific semantics that are not part of this stream
- run the relevant install, typecheck, test and build commands before declaring completion
- report the files changed and the commands/results at the end

If there is a genuine contradiction between the repository documents that blocks implementation, identify the exact conflict rather than silently choosing a new architecture.

Otherwise, make the simplest implementation consistent with the existing docs and finish the foundation.