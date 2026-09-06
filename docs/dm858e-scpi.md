# DM858E SCPI Notes

## Scope

This file records DM858E-specific command behaviour and ownership rules used by Rigol Web. It is not a replacement for the Rigol programming guide; it documents the subset of behaviour that matters to the implementation.

## Function state

The authoritative function is read with:

```text
SENSe:FUNCtion?
```

Known function tokens used by the backend are:

| Function | Token |
| --- | --- |
| DC voltage | `VOLT` / `VOLT:DC` |
| AC voltage | `VOLT:AC` |
| DC current | `CURR` / `CURR:DC` |
| AC current | `CURR:AC` |
| 2-wire resistance | `RES` |
| 4-wire resistance | `FRES` |
| Continuity | `CONT` |
| Diode | `DIOD` |
| Frequency | `FREQ` |
| Period | `PER` |
| Capacitance | `CAP` |
| Temperature | `TEMP` |

Function writes use `SENSe:FUNCtion "..."` and are performed as immediate operations.

## Range ownership

Range is read from the function-specific `SENSe:*:RANGe?` query together with the corresponding `:AUTO?` state.

The authoritative fixed ranges exposed by the UI are defined in `src/shared/dm858e-capabilities.ts`.

The current supported range groups are:

| Function | Fixed ranges |
| --- | --- |
| DC voltage | 100 mV, 1 V, 10 V, 100 V, 1000 V |
| AC voltage | 100 mV, 1 V, 10 V, 100 V, 750 V |
| DC current | 100 µA, 1 mA, 10 mA, 100 mA, 1 A, 3 A |
| AC current | 100 µA, 1 mA, 10 mA, 100 mA, 1 A, 3 A |
| 2-wire resistance | 100 Ω through 100 MΩ |
| 4-wire resistance | 100 Ω through 100 kΩ |
| Frequency input voltage | 100 mV, 1 V, 10 V, 100 V, 750 V |
| Period input voltage | 100 mV, 1 V, 10 V, 100 V, 750 V |
| Capacitance | 1 nF through 100 mF |

Frequency and period range are input-conditioning voltage ranges. They are not output Hz/s ranges and must not be reused as graph Y limits or output-resolution metadata.

## Acquisition rate

DC voltage/current and resistance use their function-specific `NPLC` controls.

The supported rate mapping is:

| UI rate | PLC |
| --- | ---: |
| Slow / 5.5 digit | 20 |
| Medium / 4.5 digit | 5 |
| Fast / 4.5 digit | 0.4 |

AC voltage/current use the `CONFigure:* <range>,<resolution>` relationship because there is no NPLC command for those functions. The resolution ratio is:

| UI rate | Resolution/range |
| --- | ---: |
| Slow | `1e-5` |
| Medium | `1e-4` |
| Fast | `1e-3` |

An AC rate write first re-reads the current physical range in the same immediate scheduler operation. It does not reuse a range captured by an earlier runtime state poll because doing so can overwrite a more recent front-panel or browser range change.

## Latest-reading snapshots

The latest display state is read with `DATA:LAST?` rather than by initiating a new measurement. Snapshot polling is therefore a latest-state observation, not a one-event-per-conversion sample stream.

The Programming Guide documents:

- `DATA:LAST?` as returning the last performed measurement data and measurement function;
- the bare no-data sentinel `9.90000000E+37`;
- DM858E reading memory as limited to 20,000 readings, after which new readings overwrite the oldest.

Those commands do not provide a coherent sample identity when queried independently. In particular, a point-count change cannot safely be paired with a separately queried `DATA:LAST?`, and raw SCPI can change the reading-memory count without creating a measurement. The backend therefore does **not** use `DATA:POINts?` to infer freshness and does not attach a browser sequence number to `DATA:LAST?`.

A physical DM858E capture on 2026-09-06 returned `2.71868584E-03 A` from `DATA:LAST?` while DC current was active. The numeric value is already expressed in SI amperes; the selected current range does not change the numeric unit of `DATA:LAST?`. Current snapshots therefore preserve the parsed value exactly, just like voltage and resistance, and must not apply range-dependent mA/µA rescaling. Engineering prefixes are a browser display concern only.

`DmmPoller` does not own a retained snapshot or dedupe baseline. It forwards every non-null sampled observation to `DmmRuntime`. `DmmRuntime.currentSnapshot` is the single server-side latest-display owner and performs display dedupe plus subscriber replay. This one-owner rule is important because runtime-generated invalidation must immediately change the same baseline used for later dedupe.

A stable current snapshot can be published immediately, including an existing stopped/single-trigger reading present when the route first subscribes. When another browser session subscribes while that runtime is already active, the runtime republishes `currentSnapshot`, so a second tab or reconnecting browser receives the current stopped/stable display without restarting the instrument session.

Snapshot state is session-scoped. Disconnect, stop, transport failure and session replacement clear the retained snapshot before a later session can replay anything.

Every real `DmmStateStore` change invalidates a retained snapshot immediately, including same-function range or acquisition-rate changes. The runtime replaces `currentSnapshot` with `DmmReadingKind.Unavailable` / `ConfigurationChanged`, publishes the new state, then publishes the invalidation. Equivalent state replacements are suppressed by `DmmStateStore`, so unchanged periodic polls do not blank a valid reading.

Because the invalidation updates the same runtime baseline used for dedupe, the next valid numeric reading is published even if its numeric value equals the pre-change value. There is no second poller cache that can suppress it.

Host-side sample count, statistics and trend calculations must wait for a separately verified acquisition path that establishes one event per physical measurement. They must not infer samples from snapshot polling cadence or snapshot changes.

### Snapshot validity and resolution ownership

Each snapshot observation is one scheduler operation. The common ownership checks read:

1. `STATus:OPERation:CONDition?` before;
2. `CONFigure?` before;
3. function-specific resolution context before, when required;
4. `SENSe:FUNCtion?` before;
5. `DATA:LAST?`;
6. `SENSe:FUNCtion?` after;
7. `CONFigure?` after;
8. function-specific resolution context after, when required;
9. `UNIT:TEMPerature?` in the same transaction when temperature is active;
10. `STATus:OPERation:CONDition?` after.

The before/after function must remain stable and match the function expected by the poller. The raw before/after `CONFigure?` response must also remain stable. Any additional function-specific resolution context must also agree before/after. A function, configuration or effective-resolution transition during the observation returns no snapshot because the numeric value cannot safely be attributed to one context.

Operation Status bit 8 (`256`) is documented as **Configuration change**. If bit 8 is present while function/configuration ownership is stable, the driver publishes `Unavailable/ConfigurationChanged` rather than a numeric value.

Protocol version 4 makes numeric display resolution part of the snapshot contract:

```ts
{
  kind: DmmReadingKind.Value,
  function,
  value,
  resolution,
  unit,
}
```

`resolution` is a positive finite measurement quantum authoritative for that stable observation. The browser rounds `value` to this quantum before engineering-prefix formatting. It does not reconstruct precision from digit class, acquisition-rate labels, numeric magnitude or `DmmState.range`.

Resolution ownership is explicitly per function in `src/shared/dm858e-capabilities.ts`:

| Function group | Authoritative numeric-resolution source |
| --- | --- |
| DCV, ACV, DCI, ACI, 2WR, 4WR | `CONFigure?` resolution field |
| Capacitance | effective `SENSe:CAPacitance:RANGe?` × `1e-3` |
| Frequency, period | unverified; numeric snapshot unavailable |
| Continuity, diode, temperature | unverified; numeric snapshot unavailable |

For capacitance, Programming Guide §3.10.1 documents `CONFigure?` as range-only (`CAP <range>`), not range+resolution. The User Guide capacitance table expresses the ranges as `1.000 nF`, `10.00 nF`, `100.0 nF`, `1.000 µF`, and so on. Those 3.5-digit range displays establish a least-significant quantum of `1e-3 × effective capacitance range`. The snapshot transaction therefore reads `SENSe:CAPacitance:RANGe?` before and after `DATA:LAST?`; a range transition discards the observation. This also handles capacitance Auto range without guessing in the browser.

Programming Guide §3.10.6 and §3.10.8 document `CONFigure?` as exactly `FREQ` and `PER` for frequency and period. The guide does not expose a measurement range/resolution field there. The programmable frequency/period voltage range is input conditioning, not Hz/s resolution. The User Guide's 5.5-digit class alone is not promoted into a fabricated numeric quantum. Frequency and period therefore publish `Unavailable/ResolutionUnavailable` until a specification-backed or physically verified resolution source is established.

The same conservative rule remains for continuity, diode and temperature. Sensor configuration parameters such as the `385` in `TEMP FRTD,385` are not measurement resolution.

Runtime dedupe includes `resolution` as well as numeric `value`: an equal numeric value observed at a different resolution is a changed display snapshot and must be published.

The Programming Guide gives `VDC` as an explicit `DATA:LAST?` function-token example. The backend does not invent other spellings. Unknown suffixes are treated as opaque and associated with a function only while `SENSe:FUNCtion?` is stable and authoritative; a token later observed under a different function is rejected.

### No-data and overload

The Programming Guide documents the **bare** numeric response `9.90000000E+37` when `DATA:LAST?` has no available measurement data. The backend publishes an explicit `Unavailable/NoData` snapshot for that condition so the UI does not leave a previous numeric value looking current.

The guide does not document a suffixed `DATA:LAST?` sentinel as overload. A sentinel-sized suffixed response is therefore represented as `Unavailable/UnclassifiedSentinel`, not guessed to be overload.

The Questionable Data register has documented overload event bits, but the event register is asynchronous to `DATA:LAST?` and is clear-on-read. The background poller therefore does not query `STATus:QUEStionable:EVENt?`; explicit raw SCPI remains free to inspect it with its documented semantics.

`DmmReadingKind.Overload` remains available in the shared contract for a future measurement-correlated mechanism, but this backend does not emit it without specification or physical-device evidence that ties the overload condition to the reported measurement.

The initial cadence remains:

- latest-reading snapshot observation: 100 ms;
- authoritative DMM state poll: 1 s.
