# DM858E E — Integration / Real Instrument

## Audience

Start after both `dm858e-backend.md` and `dm858e-frontend.md` are complete and merged.

This stream wires the real DM858E backend to the completed route/UI, verifies the route-driven transport lifecycle against both instruments, and performs the first real-device SCPI behaviour/throughput pass.

## Read before changing code

- `docs/dm858e-ui-plan.md`
- all `docs/workstreams/dm858e-*.md`
- `docs/testing.md`
- `docs/server-architecture.md`
- `docs/frontend.md`
- `docs/scpi-scheduler.md`

## Objective

Produce one integrated application where:

- `/` operates the DHO804
- `/dm858e` operates the DM858E
- only subscribed instrument runtimes have active SCPI transports
- route switching starts/stops the correct instrument cleanly
- two browser tabs can keep two different instruments active concurrently
- the DM858E primary reading and basic controls work against real hardware
- raw SCPI targets the correct instrument
- no logging functionality is introduced

## Integration work

Wire the backend and frontend contracts without broad redesign.

Resolve only concrete integration mismatches. If a shared contract must change, update all callers directly; do not add compatibility aliases or dual protocol surfaces.

Confirm the production HTTP fallback correctly supports direct navigation to `/dm858e`.

## Real DM858E verification

Verify against the physical DM858E:

- LAN SCPI connection behaviour and actual port/configuration
- `*IDN?` response parsing/model validation
- each implemented measurement-function command
- Auto/fixed range command and query behaviour
- Slow/Medium/Fast command/query behaviour
- primary reading parsing
- front-panel changes while the web route is active
- disconnect/reconnect behaviour
- clean socket shutdown when the last `/dm858e` subscriber leaves

Do not treat unverified assumptions from manuals or another Rigol instrument as device facts.

## Acquisition benchmark

Measure the actual primary-reading path rather than assuming the advertised maximum reading rate equals achievable repeated network-query throughput.

Benchmark at least:

- sustained simple primary reading acquisition in Slow
- sustained simple primary reading acquisition in Medium
- sustained simple primary reading acquisition in Fast
- interactive control latency while readings are active

If repeated single-reading queries materially underperform and the Programming Guide provides a supported buffered/triggered acquisition mechanism, compare it before changing architecture.

Only adopt a more complex acquisition strategy if measurement shows a useful benefit.

Keep the chosen strategy behind the backend acquisition boundary established in stream C.

## Route / lifecycle verification

Exercise:

1. server starts with no active instrument transports
2. open `/` -> DHO804 connects
3. navigate to `/dm858e` -> DHO804 stops and DM858E connects when that was the only tab
4. navigate back -> reverse transition
5. two tabs on `/` -> one scope transport remains active until both leave
6. one tab on `/`, one on `/dm858e` -> both transports remain independently active
7. close a tab without explicit navigation -> its subscriptions are released
8. rapid route switching does not leave stale runtimes active

## DHO804 regression

Run the full existing scope test suite and perform a quick real DHO804 smoke pass:

- connection
- live waveform
- controls
- trigger
- measurements
- raw SCPI
- deep capture

The DM858E addition must not degrade existing scope interaction semantics.

## Tests and checks

Add integration/regression tests for any real mismatches discovered during this stream.

Run:

```text
pnpm typecheck
pnpm test
pnpm build
```

Document measured DM858E SCPI behaviour and any resulting architecture decision back into the relevant repo docs. Keep current facts/decisions, not a chronological session log.

## Completion criteria

The work is complete when both physical instruments operate through their routes, route subscriptions reliably own SCPI transport lifetime, the DM858E's first-pass controls/readings are verified on hardware, and the DHO804 remains fully functional.
