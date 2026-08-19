# TypeScript Practices

## Purpose

These conventions apply to TypeScript code in Rigol Web.

Keep the type model explicit and concrete. Prefer types that describe valid application states directly rather than making fields optional for implementation convenience.

## Required fields

A property should be optional only when absence has real domain meaning.

Do not use `undefined`, `null` or optional members merely to make an object easier to construct.

Avoid:

```ts
interface ScopeState {
  channels?: ChannelState[];
  trigger?: TriggerState;
}
```

Prefer:

```ts
interface ScopeState {
  channels: ChannelState[];
  trigger: TriggerState;
}
```

If an object is only valid when a value exists, require that value in the type.

## Model real states explicitly

When a value has genuinely different valid forms, use a discriminated union rather than a bag of optional fields.

```ts
export enum ScopeConnectionState {
  Disconnected = 0,
  Connecting = 1,
  Connected = 2,
}

type ScopeConnection =
  | {
      state: ScopeConnectionState.Disconnected;
      reason: string;
    }
  | {
      state: ScopeConnectionState.Connecting;
    }
  | {
      state: ScopeConnectionState.Connected;
      identity: ScopeIdentity;
      scope: ScopeState;
    };
```

The discriminant should make each valid state obvious and allow exhaustive handling.

## Enums

Use actual TypeScript `enum`s for fixed domain and protocol values.

Prefer numeric enums rather than string enums.

```ts
export enum MessageType {
  ScopeState = 1,
  ControlSet = 2,
  InteractionUpdate = 3,
  InteractionCommit = 4,
}
```

Use the same approach for values such as channels, control kinds, acquisition actions and connection states where an enum represents a fixed set cleanly.

Protocol enum values must be assigned deliberately and remain stable once used on the wire. Do not rely on enum member ordering for protocol compatibility.

Internal-only enums may use normal numeric auto-incrementing when the actual numeric value has no external meaning.

Do not replace an ordinary enum with an `as const` object plus an inferred union without a concrete reason.

Do not use string enums merely to make serialized messages human-readable. Debuggability should come from descriptive field names and TypeScript symbols, not repeated strings on the wire.

## Protocol objects

Keep object property names descriptive even when enum values are numeric.

Prefer:

```ts
{
  type: MessageType.InteractionUpdate,
  control: {
    kind: ControlKind.ChannelOffset,
    channel: Channel.Ch1,
    value: 0.42,
  },
}
```

Do not compress structured messages into positional arrays merely to save a few bytes.

## Filenames

TypeScript filenames use lowercase kebab-case.

Examples:

```text
scpi-transport.ts
scpi-scheduler.ts
dho804-driver.ts
scope-controller.ts
live-waveform-service.ts
```

Types, classes and enums use normal PascalCase naming inside those files.

Do not use `index.ts` files as barrel exports or generic entrypoint names.

Import from the file that owns the symbol. Give executable entrypoints descriptive names such as `server.ts`.

## General rule

Prefer types that make invalid states difficult to represent without creating abstraction for its own sake.

Strong typing should make the code easier to understand and change, not produce generic type machinery that hides straightforward application behaviour.
