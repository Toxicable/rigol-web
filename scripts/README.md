# DHO804 probe

`probe-dho804-waveform.ts` is a TypeScript-only probe for replaying the
waveform path against a real DHO804. It exercises STOP, timebase changes, RUN,
preamble reads, and `:WAVeform:DATA?` while reporting payload sizes and
timeouts.

The probe must run from the LAN host namespace. The workspace container is not
on the instrument LAN, so compile the TypeScript locally and run the emitted
module through a host-networked Node container:

```bash
probe_dir=$(mktemp -d)
./node_modules/.bin/tsc --outDir "$probe_dir" \
  --ignoreConfig --target ES2022 --module NodeNext \
  --moduleResolution NodeNext --types node \
  scripts/probe-dho804-waveform.ts

docker --context fabian-server run --rm --network host -i \
  node:22-bookworm-slim node --input-type=module - \
  0.0002 0.0005 0.001 0.002 0.005 0.01 \
  < "$probe_dir/probe-dho804-waveform.js"
```

Stop `rigol-web` before probing the real scope. The DHO804 SCPI endpoint can
return responses out of sequence when the application and a probe poll it at
the same time, which makes the result invalid. Restart the service afterward:

```bash
docker --context fabian-server stop rigol-web
# run the probe
docker --context fabian-server start rigol-web
```

The probe's same-socket reuse check is diagnostic only. A `DATA?` response
whose header declares 999 bytes may stop early. Roll accepts that short frame;
Main discards it. A clean follow-up readback proves the socket can be reused
for that particular occurrence, but a later framing error still causes normal
transport recovery.
