# DHO804 bandwidth-limit validation

Static validation completed 2026-09-09:

- DHO804 domain enum has stable values `Off = 1`, `Mhz20 = 2`.
- `ChannelState` carries required authoritative bandwidth-limit state.
- protocol hard-cuts to version 9 and appends `ControlKind.ChannelBandwidthLimit = 18` without renumbering prior values.
- WebSocket input accepts only the two bandwidth-limit enum values.
- server control maps to `:CHANnel<n>:BWLimit OFF|20M` and reconciles the affected channel.
- driver reads `:CHANnel<n>:BWLimit?` and parses `OFF`/`20M`.
- driver fixture coverage includes both the default OFF path and explicit 20M readback.
- browser channel UI exposes Full / 20 MHz.

The execution environment available to this change does not have network access for a local repository checkout, and the repository has no GitHub Actions workflow available as an execution substitute. `pnpm typecheck`, `pnpm test`, and `pnpm build` therefore remain unexecuted rather than being claimed as passed.
