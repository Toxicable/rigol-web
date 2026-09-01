# Four-channel compound waveform probe

This is a temporary DHO804 performance/compatibility probe for one specific question: can CH1-CH4 NORMAL/BYTE waveform reads be issued as one SCPI program message and returned as four IEEE488.2 binary blocks?

The probe compares 10 alternating-order paired rounds of:

- separate: `SOURCE CH1` + `DATA?`, then CH2, CH3, CH4;
- compound: `SOURCE CH1;DATA?;SOURCE CH2;DATA?;SOURCE CH3;DATA?;SOURCE CH4;DATA?` as one program message.

Every returned block must contain exactly 999 bytes. The compound parser accepts semicolon-separated or line-separated IEEE488.2 blocks because the real DHO804 behavior is what this experiment is intended to establish.

Do not run this beside the normal Rigol Web scope session. Both connections would mutate the DHO804 waveform source and make the result ambiguous. Stop the service, run the one-off container with the same configured scope environment, then start the service again:

```bash
docker compose stop rigol-web
docker compose run --rm --no-deps rigol-web npm run probe:four-channel
docker compose up -d rigol-web
```

The useful success line is:

```text
[SCPI-PROBE] four-channel-compound:summary {...}
```

It reports count, median, mean, min, and max for both paths plus `medianRatio = compoundMedian / separateMedian`.

If the DHO804 only returns one binary block for the compound message, the probe times out after 2 seconds and reports how many complete leading binary blocks were received. A failed probe does not imply the normal Rigol Web transport is broken; this script uses its own temporary TCP connection and parser specifically so an unsupported multi-binary response cannot desynchronize the production session.

This probe is software-only and costs $0.
