# Rigol Web

## UI development

Run the local development server from this directory:

```bash
npm run dev
```

It starts the TypeScript backend with `.env` loaded and Vite on
`http://localhost:5173`. Vite proxies `/ws` and `/health` to the backend on
port `3000`, so browser UI edits hot-reload without rebuilding the Docker
image.

To use the authenticated external hostname during development, run:

```bash
npm run dev:external
```

This stops the production container and reverse-tunnels Vite to the same
`192.168.1.12:3018` backend that Caddy always uses. Exiting the command stops
the development server and restores the production container. Caddy remains
unchanged.

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

```bash
docker compose up --build --detach
```

The HTTP and WebSocket service listens on port `3000` in the container. Its
`/health` endpoint verifies only that the Node process is running; it remains
healthy while the scope is disconnected.
