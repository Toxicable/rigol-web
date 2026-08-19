# DHO804 Scope Model

## Purpose

This document defines the initial Rigol Web domain model for the DHO804 and maps that model to the DHO804 SCPI interface.

It is the contract between:

- the DHO804 driver
- cached server scope state
- browser state
- browser control messages

The model is deliberately DHO804-specific. It does not attempt to represent every feature in the DHO800/DHO900 command set.

The Rigol DHO800/DHO900 Programming Guide, April 2025, is the primary source for SCPI syntax and return values. The DHO800 User Guide is used where the user-facing meaning of a setting needs clarification.

## Modelling rules

`ScopeState` represents the important effective state of a connected DHO804.

Use these rules:

- all fields are required unless absence has genuine domain meaning
- fixed domain values use numeric TypeScript enums
- physical quantities use numbers in SI units
- do not expose Rigol SCPI abbreviations directly to the browser
- do not put waveform sample arrays in `ScopeState`
- do not put live measurement values in `ScopeState`
- do not use generic string property paths
- do not make the model generic for other oscilloscopes

The driver is responsible for converting between Rigol SCPI strings and the shared TypeScript model.

## Scope identity

On connection, query:

```text
*IDN?
```

The Programming Guide defines the returned format as:

```text
RIGOL TECHNOLOGIES,<model>,<serial number>,<software version>
```

Represent it as:

```ts
export interface ScopeInfo {
  manufacturer: string;
  model: string;
  serialNumber: string;
  softwareVersion: string;
}
```

The initial driver must require `model === "DHO804"`.

Do not silently continue with another model and hope its behaviour is compatible.

## Channels

The DHO804 has exactly four analog channels.

```ts
export enum Channel {
  Ch1 = 1,
  Ch2 = 2,
  Ch3 = 3,
  Ch4 = 4,
}

export enum ChannelCoupling {
  Ac = 1,
  Dc = 2,
  Ground = 3,
}

export interface ChannelState {
  channel: Channel;
  enabled: boolean;
  coupling: ChannelCoupling;
  scale: number;
  offset: number;
  probeRatio: number;
}

export type ChannelStates = [
  ChannelState,
  ChannelState,
  ChannelState,
  ChannelState,
];
```

Units:

- `scale`: V/div
- `offset`: V
- `probeRatio`: dimensionless attenuation ratio

Each tuple member still carries its `channel` identity. The tuple guarantees four channels while the explicit field prevents array position becoming the only channel identifier.

### Channel SCPI mapping

For channel `n` from 1 to 4:

| State field | Query | Set | Query return |
| --- | --- | --- | --- |
| `enabled` | `:CHANnel<n>:DISPlay?` | `:CHANnel<n>:DISPlay {ON|OFF}` | `1` or `0` |
| `coupling` | `:CHANnel<n>:COUPling?` | `:CHANnel<n>:COUPling {AC|DC|GND}` | `AC`, `DC`, `GND` |
| `scale` | `:CHANnel<n>:SCALe?` | `:CHANnel<n>:SCALe <value>` | scientific notation, V/div |
| `offset` | `:CHANnel<n>:OFFSet?` | `:CHANnel<n>:OFFSet <value>` | scientific notation, V |
| `probeRatio` | `:CHANnel<n>:PROBe?` | not required by the initial UI | numeric ratio |

For a 1X probe ratio, the DHO800 vertical scale range is 500 µV/div to 10 V/div. Fine adjustment means scale must remain a number rather than a fixed 1-2-5 enum.

The permitted offset range depends on the current vertical scale. Do not duplicate that relationship as a large client-side type. The scope remains authoritative and the final interaction value is read back after commit.

### `OFFSet` versus `POSition`

Use `:CHANnel<n>:OFFSet` for the Rigol Web vertical offset control.

The Programming Guide also defines `:CHANnel<n>:POSition`, but describes it as channel bias voltage. The User Guide describes the front-panel Vertical POSITION control and drag gesture as changing the channel vertical offset.

Do not use both commands for the same browser control.

### Probe ratio values

Keep `probeRatio` as a number rather than a closed enum for now.

The Programming Guide's `:CHANnel<n>:PROBe` command lists a narrower set of accepted values than the DHO800 datasheet's probe attenuation table. Until this is bench-verified on the DHO804, the driver should parse a returned positive finite numeric ratio rather than rejecting a value simply because the two manuals disagree about the complete set.

The initial UI does not need to write probe ratio, so this discrepancy does not block version 1.

## Horizontal state

```ts
export enum TimebaseMode {
  Main = 1,
  Roll = 2,
  Xy = 3,
}

export interface HorizontalState {
  mode: TimebaseMode;
  scale: number;
  position: number;
}
```

Units:

- `scale`: s/div
- `position`: s

The browser calls the second value horizontal position because that is how the scope presents it to the user. The corresponding SCPI command calls it main timebase offset.

### Horizontal SCPI mapping

| State field | Query | Set | Query return |
| --- | --- | --- | --- |
| `scale` | `:TIMebase:MAIN:SCALe?` | `:TIMebase:MAIN:SCALe <value>` | scientific notation, s/div |
| `position` | `:TIMebase:MAIN:OFFSet?` | `:TIMebase:MAIN:OFFSet <value>` | scientific notation, s |
| XY enabled | `:TIMebase:XY:ENABle?` | not required in v1 | `1` or `0` |
| base mode | `:TIMebase:MODE?` | not required in v1 | `MAIN` or `ROLL` |

The DHO800 timebase range is 5 ns/div to 500 s/div.

### Timebase mode quirk

`:TIMebase:MODE?` cannot identify XY mode reliably. The Programming Guide explicitly states that after configuring XY mode, `:TIMebase:MODE?` returns `MAIN`.

Derive the model value as follows:

```text
if :TIMebase:XY:ENABle? == 1
    mode = Xy
else if :TIMebase:MODE? == ROLL
    mode = Roll
else
    mode = Main
```

Do not confuse `:TIMebase:ROLL?` with the current timebase mode. That command reports whether automatic roll behaviour is enabled.

XY and Roll are not version 1 control targets, but detecting them prevents the browser from incorrectly assuming the scope is in ordinary YT/Main mode after the physical controls change it.

## Acquisition state

```ts
export enum AcquisitionType {
  Normal = 1,
  Peak = 2,
  Average = 3,
  Ultra = 4,
}

export interface AcquisitionState {
  type: AcquisitionType;
  averages: number;
  memoryDepth: number;
  sampleRate: number;
}
```

Units:

- `memoryDepth`: samples
- `sampleRate`: Sa/s

`averages` remains required even while the acquisition type is not `Average`. The scope retains this setting and `:ACQuire:AVERages?` has a valid numeric result independently of whether it is currently active. Making it required avoids creating an optional field for an inactive-but-still-defined setting.

### Acquisition SCPI mapping

| State field | Query | Set | Query return |
| --- | --- | --- | --- |
| `type` | `:ACQuire:TYPE?` | `:ACQuire:TYPE <type>` | `NORM`, `PEAK`, `AVER`, `ULTR` |
| `averages` | `:ACQuire:AVERages?` | `:ACQuire:AVERages <count>` | integer 2 to 65536 |
| `memoryDepth` | `:ACQuire:MDEPth?` | `:ACQuire:MDEPth <depth>` | scientific notation |
| `sampleRate` | `:ACQuire:SRATe?` | read only | scientific notation, Sa/s |

Average count is a power of two from 2 through 65536. The scope rounds a non-power-of-two write down to the closest permitted value.

The DHO804 effective maximum sample rate depends on the number of enabled channels:

- one enabled channel: 1.25 GSa/s
- two enabled channels: 625 MSa/s
- three or four enabled channels: 312.5 MSa/s

The DHO804 maximum selectable memory depth similarly depends on enabled-channel count. The important application state is the effective numeric depth returned by `:ACQuire:MDEPth?`; do not encode the selected `AUTO` token into `ScopeState` because the query returns an effective numeric depth rather than an `AUTO` state.

`sampleRate` is authoritative read-only state. Do not create a fake setter for it.

## Run state

The DHO804 exposes operating status through `:TRIGger:STATus?` even though the User Guide presents it as the instrument run-state label.

Model that status at the top level rather than mixing it with edge-trigger configuration:

```ts
export enum ScopeRunState {
  Triggered = 1,
  Waiting = 2,
  Running = 3,
  Auto = 4,
  Stopped = 5,
}
```

SCPI mapping:

| SCPI return | Model value |
| --- | --- |
| `TD` | `ScopeRunState.Triggered` |
| `WAIT` | `ScopeRunState.Waiting` |
| `RUN` | `ScopeRunState.Running` |
| `AUTO` | `ScopeRunState.Auto` |
| `STOP` | `ScopeRunState.Stopped` |

Do not collapse these values into a boolean `running`. `WAIT`, `TD` and `AUTO` are meaningful operating states visible on the instrument.

Run/Stop/Single actions use the root commands:

```text
:RUN
:STOP
:SINGle
```

They remain commands rather than desired-state writes to `ScopeRunState`.

## Trigger state

Rigol terminology is easy to confuse here:

- `:TRIGger:MODE` means trigger **type** such as Edge, Pulse or CAN
- `:TRIGger:SWEep` means trigger **sweep mode** Auto, Normal or Single
- `:TRIGger:STATus?` returns the current operating/run status

Keep those concepts separate in the model.

```ts
export enum TriggerType {
  Edge = 1,
  Pulse = 2,
  Slope = 3,
  Video = 4,
  Pattern = 5,
  Duration = 6,
  Timeout = 7,
  Runt = 8,
  Window = 9,
  Delay = 10,
  SetupHold = 11,
  NthEdge = 12,
  Rs232 = 13,
  I2c = 14,
  Spi = 15,
  Can = 16,
}

export enum TriggerSweep {
  Auto = 1,
  Normal = 2,
  Single = 3,
}

export enum EdgeSlope {
  Rising = 1,
  Falling = 2,
  Either = 3,
}

export enum TriggerCoupling {
  Ac = 1,
  Dc = 2,
  LowFrequencyReject = 3,
  HighFrequencyReject = 4,
}
```

The DHO800 does not support LIN trigger, so it is intentionally absent from `TriggerType`.

The DHO804 also has no external trigger input. Edge trigger source is therefore exactly one of the four analog channels.

### Edge versus other trigger types

Version 1 controls Edge trigger. Physical scope controls or another SCPI client can still change the scope to another supported trigger type.

Represent that honestly without filling the type with optional edge-only properties:

```ts
export type OtherTriggerType =
  | TriggerType.Pulse
  | TriggerType.Slope
  | TriggerType.Video
  | TriggerType.Pattern
  | TriggerType.Duration
  | TriggerType.Timeout
  | TriggerType.Runt
  | TriggerType.Window
  | TriggerType.Delay
  | TriggerType.SetupHold
  | TriggerType.NthEdge
  | TriggerType.Rs232
  | TriggerType.I2c
  | TriggerType.Spi
  | TriggerType.Can;

export type TriggerState =
  | {
      type: TriggerType.Edge;
      sweep: TriggerSweep;
      source: Channel;
      slope: EdgeSlope;
      level: number;
      coupling: TriggerCoupling;
    }
  | {
      type: OtherTriggerType;
      sweep: TriggerSweep;
    };
```

The second variant means "the scope is using a trigger type that version 1 does not model in detail". It is still valid and authoritative state for the parts Rigol Web understands.

Do not invent optional `source`, `level` or `slope` fields on all trigger types.

### Trigger type mapping

`:TRIGger:MODE?` returns abbreviated values.

| SCPI return | Model value |
| --- | --- |
| `EDGE` | `TriggerType.Edge` |
| `PULS` | `TriggerType.Pulse` |
| `SLOP` | `TriggerType.Slope` |
| `VID` | `TriggerType.Video` |
| `PATT` | `TriggerType.Pattern` |
| `DUR` | `TriggerType.Duration` |
| `TIM` | `TriggerType.Timeout` |
| `RUNT` | `TriggerType.Runt` |
| `WIND` | `TriggerType.Window` |
| `DEL` | `TriggerType.Delay` |
| `SET` | `TriggerType.SetupHold` |
| `NEDG` | `TriggerType.NthEdge` |
| `RS232` | `TriggerType.Rs232` |
| `IIC` | `TriggerType.I2c` |
| `SPI` | `TriggerType.Spi` |
| `CAN` | `TriggerType.Can` |

If a DHO804 returns an unknown trigger type, fail parsing clearly instead of treating it as Edge or silently assigning a default.

### Trigger sweep mapping

`:TRIGger:SWEep?` returns:

| SCPI return | Model value |
| --- | --- |
| `AUTO` | `TriggerSweep.Auto` |
| `NORM` | `TriggerSweep.Normal` |
| `SING` | `TriggerSweep.Single` |

### Edge trigger SCPI mapping

When `type === TriggerType.Edge`, use:

| State field | Query | Set | Query return |
| --- | --- | --- | --- |
| `source` | `:TRIGger:EDGE:SOURce?` | `:TRIGger:EDGE:SOURce CHANnel<n>` | `CHAN1` to `CHAN4` |
| `slope` | `:TRIGger:EDGE:SLOPe?` | `:TRIGger:EDGE:SLOPe <slope>` | `POS`, `NEG`, `RFAL` |
| `level` | `:TRIGger:EDGE:LEVel?` | `:TRIGger:EDGE:LEVel <value>` | scientific notation |
| `coupling` | `:TRIGger:COUPling?` | `:TRIGger:COUPling <coupling>` | `AC`, `DC`, `LFR`, `HFR` |

Slope mapping:

```text
Rising  -> POSitive
Falling -> NEGative
Either  -> RFALl
```

For an analog source, the Programming Guide defines the edge trigger-level range as:

```text
(-4.5 × VerticalScale - Offset) through
( 4.5 × VerticalScale - Offset)
```

As with channel offset, the scope remains authoritative for dependent range enforcement.

Do not query edge-only fields when the current trigger type is not Edge merely to populate a structurally convenient object.

## Complete `ScopeState`

The shared connected-scope state is therefore:

```ts
export interface ScopeState {
  channels: ChannelStates;
  horizontal: HorizontalState;
  acquisition: AcquisitionState;
  runState: ScopeRunState;
  trigger: TriggerState;
}
```

This is the state sent in full by the WebSocket `ScopeState` message.

Connection lifecycle and `ScopeInfo` remain outside `ScopeState` because a disconnected application does not have a valid connected-scope snapshot.

## Initial state read

After the TCP connection is established and `*IDN?` confirms a DHO804, build the initial snapshot from the scope before announcing `ScopeConnected` to the browser.

The logical read set is:

```text
*IDN?

:CHAN1:DISP?
:CHAN1:COUP?
:CHAN1:SCAL?
:CHAN1:OFFS?
:CHAN1:PROB?
...
:CHAN4:DISP?
:CHAN4:COUP?
:CHAN4:SCAL?
:CHAN4:OFFS?
:CHAN4:PROB?

:TIM:XY:ENAB?
:TIM:MODE?
:TIM:MAIN:SCAL?
:TIM:MAIN:OFFS?

:ACQ:TYPE?
:ACQ:AVER?
:ACQ:MDEP?
:ACQ:SRAT?

:TRIG:STAT?
:TRIG:MODE?
:TRIG:SWE?
```

If the trigger type is Edge, additionally query:

```text
:TRIG:EDGE:SOUR?
:TRIG:EDGE:SLOP?
:TRIG:EDGE:LEV?
:TRIG:COUP?
```

The examples use valid abbreviated SCPI forms. The driver may use either these or the corresponding full SCPI spellings consistently.

Do not announce a connected scope with a half-populated state object.

## Polling

The same model drives background state validation.

Target approximately one validation cycle per second, at scheduler background priority. A new poll cycle must not pile up behind an unfinished previous poll cycle.

The initial implementation can use straightforward serialized queries. Do not introduce SCPI command batching until it has been verified against the real DHO804 and shown to improve latency without making response ownership ambiguous.

Polling correctness does not depend on every query landing at an exact 1.000 Hz. Interactive and immediate scheduler work takes priority.

When a property is under active browser interaction:

- the poll may still query the scope
- stale poll data must not overwrite the optimistic interactive value for that property
- the committed final value is sent at immediate priority
- the relevant property is then explicitly queried once
- the authoritative readback is reconciled into `ScopeState`

See `scpi-scheduler.md` for scheduling behaviour.

## Control-to-SCPI mapping

The initial browser controls map as follows:

| Browser control/action | SCPI write | Scheduler class |
| --- | --- | --- |
| channel enabled | `:CHAN<n>:DISP {ON|OFF}` | normal |
| channel vertical scale | `:CHAN<n>:SCAL <value>` | interactive when continuously manipulated, otherwise normal |
| channel vertical offset | `:CHAN<n>:OFFS <value>` | interactive |
| horizontal scale | `:TIM:MAIN:SCAL <value>` | interactive when pinch/drag driven, otherwise normal |
| horizontal position | `:TIM:MAIN:OFFS <value>` | interactive |
| select Edge trigger | `:TRIG:MODE EDGE` | normal |
| Edge trigger source | `:TRIG:EDGE:SOUR CHAN<n>` | normal |
| Edge trigger slope | `:TRIG:EDGE:SLOP <value>` | normal |
| Edge trigger level | `:TRIG:EDGE:LEV <value>` | interactive |
| Run | `:RUN` | immediate |
| Stop | `:STOP` | immediate |
| Single | `:SINGle` | immediate |

An interactive operation's final commit follows the scheduler commit/readback rules rather than merely repeating the last intermediate write.

## Measurements

Measurement values are intentionally outside `ScopeState`.

They are continuously changing results, not configuration state, and putting them in the 1 Hz authoritative scope snapshot would couple measurement refresh rate to configuration polling.

The DHO804 driver should expose measurement operations separately using `:MEASure:ITEM?` with an explicit measurement kind and source channel.

Examples:

```text
:MEASure:ITEM? VPP,CHANnel1
:MEASure:ITEM? VRMS,CHANnel1
:MEASure:ITEM? VAVG,CHANnel1
:MEASure:ITEM? FREQuency,CHANnel1
:MEASure:ITEM? PERiod,CHANnel1
```

The Programming Guide returns the current measurement value in scientific notation.

Do not make measurement values optional members of every `ChannelState`.

The exact initial UI subset of measurement kinds can be chosen by the frontend/control workstream without changing the core `ScopeState` shape.

## Waveform metadata is separate

Waveform transfer metadata also does not belong in `ScopeState`.

The waveform service obtains metadata for the acquisition being transferred, including the Rigol equivalents of:

- `XINCrement`
- `XORigin`
- `XREFerence`
- `YINCrement`
- `YORigin`
- `YREFerence`

That metadata describes a particular waveform payload and belongs with that payload/capture.

See `waveforms.md`.

## Parsing rules

The DHO804 driver owns all SCPI response parsing.

Use strict, small parsers:

- trim normal line terminators
- parse documented booleans as `0` or `1`
- parse scientific-notation physical values as finite numbers
- map documented SCPI discrete return strings exhaustively to numeric enums
- reject unknown enum tokens clearly
- reject non-finite numeric values where a configuration/state query is expected to return a finite number

Do not leak strings such as `NORM`, `RFAL`, `LFR` or `CHAN1` beyond the driver boundary.

Raw SCPI console results are the deliberate exception: they return the instrument response as raw console text because the user explicitly requested raw SCPI.

## Write validation

Avoid building a second complete oscilloscope validation engine in the server.

The DHO804 has many dependent ranges. For example:

- channel offset range depends on vertical scale
- trigger level depends on source scale and offset
- available memory depth depends on enabled-channel count and acquisition mode
- sample rate changes with timebase, memory depth and channel count

Perform cheap structural validation in Rigol Web, such as finite-number checks and known enum values, then let the DHO804 apply its own device rules. The final authoritative readback catches rounding, clamping or rejection.

Where a known discrete list is directly useful to the UI, it can be exposed deliberately, but do not duplicate every manual rule before there is a concrete need.

## Manual-derived constraints worth retaining

These DHO804 facts affect application behaviour and should not be generalized away:

- exactly four analog channels
- 70 MHz analog bandwidth
- 12-bit vertical resolution
- 5 ns/div to 500 s/div timebase range
- 500 µV/div to 10 V/div vertical scale at 1X probe ratio
- no external trigger input on DHO804
- DHO800 supports trigger types through CAN but not LIN
- one enabled channel can sample up to 1.25 GSa/s
- two enabled channels can sample up to 625 MSa/s
- three or four enabled channels can sample up to 312.5 MSa/s
- RAW internal-memory waveform reads require the scope to be stopped

The waveform-specific limits and transfer sequence belong in `waveforms.md`, not in `ScopeState`.

## Non-goals

The initial state model does not attempt to model:

- detailed Pulse/Slope/Video/Pattern/etc. trigger configuration
- Math channels
- reference channels
- digital channels
- serial decode configuration
- cursors
- histogram state
- DVM/counter state
- display appearance settings
- LAN configuration
- every acquisition/UltraAcquire sub-setting

These can be added when Rigol Web exposes the corresponding feature. They should extend the model deliberately rather than pre-populating `ScopeState` with speculative optional fields.
