# DHO804 channel bandwidth-limit model

This addendum updates the DHO804 scope model for protocol version 9.

`ChannelState` includes:

```ts
export enum ChannelBandwidthLimit {
  Off = 1,
  Mhz20 = 2,
}

interface ChannelState {
  // existing fields...
  bandwidthLimit: ChannelBandwidthLimit;
}
```

The DHO804 driver maps the field as follows:

| Model value | Query return | SCPI set |
| --- | --- | --- |
| `ChannelBandwidthLimit.Off` | `OFF` | `:CHANnel<n>:BWLimit OFF` |
| `ChannelBandwidthLimit.Mhz20` | `20M` | `:CHANnel<n>:BWLimit 20M` |

The RIGOL DHO800/DHO900 Programming Guide states that DHO800 models support the 20 MHz bandwidth limit. The 100 MHz and 200 MHz options described for DHO900 models are not part of the DHO804 domain.

The browser labels `Off` as **Full** to describe the effective signal bandwidth rather than exposing the SCPI token. The physical DHO804 remains authoritative; a control write is followed by channel-state readback.

Source: https://download.rigol.com/en/Manual/Digital%20Oscilloscope/DHO800/DHO800900_ProgrammingGuide_EN.pdf
