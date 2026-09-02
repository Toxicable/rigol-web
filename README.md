# Rigol Web

Web control and visualization for the lab Rigol instruments.

Supported instruments:

- Rigol DHO804 oscilloscope
- Rigol DM858E bench DMM

The browser uses a persistent WebSocket to the server. Instrument runtimes are activated by route subscription, so opening `/` activates the scope and opening `/dm858e` activates the DMM.

See `docs/architecture.md` for the system shape, `docs/frontend.md` for browser architecture, and the instrument-specific docs under `docs/` for current behaviour.
