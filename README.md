# Rigol Web

## Container deployment

Copy `.env.example` to `.env`, then set `RIGOL_HOST` and `RIGOL_PORT` to the
DHO804's verified raw SCPI/TCP endpoint. Do not guess the port.

```bash
docker compose up --build --detach
```

The HTTP and WebSocket service listens on port `3000` in the container. Its
`/health` endpoint verifies only that the Node process is running; it remains
healthy while the scope is disconnected.
