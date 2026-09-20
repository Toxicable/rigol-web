# Math channels

## Proposal

Implement DHO804 math channels as first-class scope-owned traces in RigolWeb.

Use the oscilloscope's native `MATH1` through `MATH4` engine for the primary implementation rather than calculating binary math from independently received browser waveform frames.

Reasons:

- The DHO800/DHO900 SCPI interface exposes four math channels and can return `MATH1`-`MATH4` directly through `:WAVeform:SOURce`.
- Native math is evaluated by the scope against its acquisition data. RigolWeb currently reads live physical channels sequentially, so browser-side `CH1 - CH2` can otherwise combine frames from different acquisition instants while running.
- Scope measurements also accept `MATH1`-`MATH4` as sources.
- The existing browser waveform path already handles calibrated display-sized `Float32` waveform frames and independent mode-2 uPlot series.

Incremental hardware/software purchase cost: **A$0**.

## Important limitation

RIGOL documents that when waveform source is `MATH1`-`MATH4`, `:WAVeform:MODE` can only be `NORMal`.

Therefore native math channels are **live/display waveform sources only in the first implementation**. They are not added to RAW deep capture. Deep-capture math would require a separate server-side derived-trace design over retained raw physical-channel data.

## Scope model

Add four explicit math states to `ScopeState`:

```ts
interface MathState {
  math: MathChannel;
  enabled: boolean;
  operator: MathOperator;
  source1: MathSource;
  source2: MathSource | null;
  scale: number | null;
  offset: number | null;
}
```

`MathChannel` is `Math1` through `Math4`.

Do not overload the physical `Channel` enum. Introduce a distinct waveform-source identity shared by driver, protocol and browser code, for example a discriminated `WaveformSource` covering physical channels and math channels.

Math sources should follow the DHO dependency restriction: Math1 cannot depend on another math channel; Math2 may depend on Math1; Math3 may depend on Math1/Math2; Math4 may depend on Math1/Math2/Math3.

## Initial writable operator scope

First UI pass should support the four ordinary arithmetic operators:

- `A + B`
- `A - B`
- `A * B`
- `A / B`

These cover the common differential and derived-power use cases without immediately requiring FFT/filter-specific controls.

If the scope is externally configured to another documented operator, RigolWeb should still read its state and display its waveform. Editing operator-specific parameters beyond arithmetic can follow later.

The DHO804 also documents unary/function, FFT, logic and filter math operators. Those should be modeled as explicit enum values rather than raw strings so later support is a direct extension, not a compatibility layer.

## Driver and server

Extend `Dho804Driver` with explicit math state/control methods:

- read math enabled state
- read/write operator
- read/write source 1
- read/write source 2 where applicable
- read/write scale where valid
- read/write offset where valid
- read live waveform from a generic `WaveformSource`

Keep RAW waveform reads restricted to physical `Channel` sources.

Generalize the live waveform setup/preamble caches from `Channel` keys to `WaveformSource` keys. Math waveform reads use the same existing normalized preamble/sample decoding path.

`LiveWaveformService` should round-robin over enabled physical and math traces. Each additional enabled math trace adds another SCPI waveform read, so aggregate live refresh rate will fall as trace count rises; do not add a speculative rate setting.

## Binary waveform protocol

Replace the header's physical-channel identity with an explicit trace/source identity capable of representing CH1-CH4 and MATH1-MATH4.

This is a hard protocol change: update server encoder and browser decoder together rather than adding legacy aliases.

The rest of the waveform frame remains unchanged: source sample indices, values and X transform are still sufficient.

## Browser waveform controller

Generalize `WaveformController` maps from `Map<Channel, ...>` to `Map<WaveformSource, ...>` for live frames.

Deep capture remains keyed by physical `Channel` only.

The plot data model should grow from four fixed physical series to eight fixed trace slots:

- CH1-CH4
- M1-M4

Continue using uPlot mode 2 because each trace can retain independent X/Y arrays.

Math traces use their own scope-reported scale and offset for Y-axis mapping rather than inheriting either source channel's vertical settings.

## UI

Add a `Math` section adjacent to the existing channel controls with rows M1-M4.

Each arithmetic math row exposes:

- enabled
- operator
- Source A
- Source B
- vertical scale
- vertical offset

Use a distinct accent for each math trace, separate from CH1-CH4.

The waveform plot renders enabled math traces exactly like physical traces, including a draggable zero/reference marker if scale/offset interaction is enabled for math.

Do not expose deep-capture controls for math traces in the first implementation.

## Measurements

Generalize measurement source identity so scope-side measurements can target math channels as well as physical channels. RIGOL documents `MATH1`-`MATH4` as valid measurement sources.

Local browser measurements can also operate on a math frame once it has been received because the existing local path consumes calibrated waveform values. Local statistics should keep separate geometry keys per math source exactly as for physical sources.

## Why not browser-local binary math first

Browser-local math is attractive because it costs no extra SCPI reads, but it has two correctness problems in the current architecture:

1. live CH1-CH4 frames are acquired sequentially, so two source frames are not guaranteed to represent the same acquisition instant;
2. deep-capture viewport frames are independently min/max downsampled and do not necessarily contain samples at matching source indices.

A later arbitrary-expression engine should therefore operate on server-owned acquisition data with explicit alignment semantics, not directly on the plotted/downsampled arrays.

## Suggested implementation order

1. Add shared math/source types and extend `ScopeState`.
2. Add DHO804 math state read/write methods and tests.
3. Generalize live waveform source handling and binary trace identity.
4. Extend browser controller/plot to CH1-CH4 + M1-M4.
5. Add arithmetic math controls and Y-scale/offset interactions.
6. Extend measurement source identity to math traces.
7. Add tests for math source protocol round-trip, stale live sequences, state/control reconciliation and disabled math traces.

## Sources

- RIGOL DHO800/DHO900 Programming Guide, `:MATH<n>` command family.
- RIGOL DHO800/DHO900 Programming Guide, `:WAVeform:SOURce`: CH1-CH4 and MATH1-MATH4 are valid sources; MATH waveform reads are NORMAL-only.
- RIGOL DHO800/DHO900 Programming Guide, measurement commands: MATH1-MATH4 are valid measurement sources.
