# Rigol Web

## UI development

Run the local development server from this directory:

```bash
npm run dev
```

It starts the TypeScript backend with `.env` loaded and Vite on
`http://localhost:5173`. Vite proxies `/ws`, `/health` and `/api` to the
backend on port `3000`, so browser UI edits hot-reload without rebuilding the
Docker image.

To use the authenticated external hostname during development, run:

```bash
npm run dev:external
```

This stops the production container and reverse-tunnels Vite to the same
`192.168.1.12:3018` backend that Caddy always uses. Exiting the command stops
the development server and restores the production container. Caddy remains
unchanged.

Selected DHO804 measurements are rendered as compact overlays on the waveform
panel. Each overlay item reuses the exact CH1-CH4 accent variable used by the
corresponding trace and channel marker. The overlay displays the scope's native
current, minimum, average, maximum, standard-deviation and count statistics;
these are read with the DHO800/DHO900 `:MEASure:STATistic:ITEM?` commands rather
than calculated from the reduced live plot data. The measurement selector is
stacked below the waveform column and does not extend beneath the right-side
scope controls.

RIGOL documents the statistic query in the DHO800/DHO900 Programming Guide:
https://download.rigol.com/en/Manual/Digital%20Oscilloscope/DHO800/DHO800900_ProgrammingGuide_EN.pdf

## Container deployment

Copy `.env.example` to `.env`, then set `RIGOL_SCOPE_HOST` and
`RIGOL_SCOPE_PORT` to the DHO804's verified raw SCPI/TCP endpoint. Configure
`RIGOL_DMM_HOST` and `RIGOL_DMM_PORT` for the DM858E endpoint.

The DHO804 **Sleep** button is deliberately separate from SCPI. The runtime
container includes the Debian `adb` client and sends Android `KEYCODE_SLEEP`
(`223`) to the scope over ADB. `RIGOL_SCOPE_ADB_PORT` defaults to `55555` and
can be changed if the scope exposes ADB elsewhere. If ADB is disabled or not
reachable, the UI reports the failed sleep request rather than pretending the
scope slept. This adds no paid software or hardware dependency; it only adds
the open-source ADB client to the container image.

Android documents key code 223 as `KEYCODE_SLEEP`:
https://developer.android.com/reference/android/view/KeyEvent#KEYCODE_SLEEP

For SCPI/TCP troubleshooting, temporarily set `RIGOL_SCPI_DEBUG=1`. Debug mode
logs instrument subscribe/unsubscribe transitions, runtime start/stop causes,
query timing, TCP chunk sizes, binary-block receive progress, and buffered-byte
counts at a timeout. Leave it at the default `0` for normal use. Deliberate
runtime shutdown now treats an in-flight SCPI cancellation as cancellation
rather than printing it as an operation failure; genuine transport failures
and query timeouts remain errors. A waveform timeout also reports how many TCP
bytes arrived and how many remained buffered, which helps distinguish a scope
that sent nothing from a partial/malformed binary response.

```bash
docker compose up --build --detach
```

The HTTP and WebSocket service listens on port `3000` in the container. Its
`/health` endpoint verifies only that the Node process is running; it remains
healthy while the scope is disconnected.

The scope statistics and diagnostics changes add no hardware, paid service, or
runtime dependency. Cost impact: **$0**.
