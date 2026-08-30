# DM858E E — Integration / Real Instrument

## Audience

Start after both `dm858e-backend.md` and `dm858e-frontend.md` are complete and merged.

This stream wires the real DM858E backend to the completed route/UI, verifies the route-driven transport lifecycle against both instruments, and performs the first real-device SCPI behaviour/throughput pass.

## Implementation status

In progress on `dm858e-integration`, based on `main` at `82f821e` after DM858E backend PR #9 and frontend PR #10 were merged.

Initial integration audit confirms the merged server already constructs `DmmRuntime`, registers it as `dm858e`, and routes DMM controls/raw SCPI through the shared `WebSocketGateway`. Stream E therefore starts from an already wired application rather than introducing a second integration layer.

Current automated integration coverage includes:

- `src/web/instrument-lifecycle.integration.test.ts`: actual `bindScopeRoute` / `bindDmmRoute` subscriptions through `ScopeWebSocketClient`, protocol handshake, real WebSocket transport, `WebSocketGateway`, `InstrumentRegistry`, and runtime spies; covers scope -> DMM -> scope switching, shared two-tab scope lifetime, independent simultaneous scope+DMM tabs, socket-close cleanup, and reconnect convergence to the browser client's final desired subscription set;
- `src/server/http-handler.test.ts`: direct `/dm858e` production SPA navigation without turning arbitrary missing assets into SPA responses;
- existing `instrument-registry.test.ts`: delayed start/stop reconciliation races and first/last-subscriber ownership remain unit-level registry coverage rather than being duplicated by the integration harness.

Repository mechanical-gate execution remains `UNKNOWN` in environments that cannot resolve `github.com`; do not treat the presence of tests as a passing `pnpm typecheck`, `pnpm test`, or `pnpm build` result. Physical DM858E/DHO804 verification remains required.

Remaining stream-E work is deliberately verification-led:

- run the normal repository mechanical gates;
- verify the documented DM858E SCPI assumptions on the physical instrument;
- measure sustained reading throughput and interactive control latency in Slow/Medium/Fast;
- add only regression fixes/tests for concrete mismatches found during those checks;
- run the DHO804 regression pass after any correction.

No logging is part of this stream.

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
