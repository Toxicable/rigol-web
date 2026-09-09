# DHO804 channel bandwidth limit

Date: 2026-09-09

RigolWeb now models and controls the DHO804 analog-channel bandwidth limit.

## Behavior

Each `ChannelState` includes an authoritative `bandwidthLimit` value:

- `ChannelBandwidthLimit.Off` — full instrument bandwidth;
- `ChannelBandwidthLimit.Mhz20` — 20 MHz bandwidth limit.

The scope route exposes the setting per channel as **Full** or **20 MHz**.

The DHO804 driver reads `:CHANnel<n>:BWLimit?` whenever it reads complete channel state. A browser change is a typed `ControlChange`, is validated at the WebSocket and controller boundaries, writes `:CHANnel<n>:BWLimit OFF|20M`, and then re-reads the affected channel so the physical scope remains authoritative.

The RIGOL DHO800/DHO900 Programming Guide documents `:CHANnel<n>:BWLimit` and states that DHO800 models support the 20 MHz limit; the query returns `20M` or `OFF`. DHO900-only 100 MHz and 200 MHz bandwidth-limit options are deliberately not represented for the DHO804.

Programming guide: https://download.rigol.com/en/Manual/Digital%20Oscilloscope/DHO800/DHO800900_ProgrammingGuide_EN.pdf

## Protocol

Adding `bandwidthLimit` to the required `ChannelState` wire payload is a hard protocol change. `PROTOCOL_VERSION` moves from 8 to 9.

`ControlKind.ChannelBandwidthLimit = 18` is appended without renumbering any existing control or message values. Version-7 acquisition-operation message IDs 60–65 remain unchanged.

Incremental hardware/software/service cost: **A$0**.
