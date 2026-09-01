# Rigol Web agent rules

## Configuration policy
- Default to one deterministic behavior. Do not add feature flags, optional settings, environment switches, compatibility modes, fallback modes, or alternate code paths unless the user explicitly requests configurability or a concrete external requirement makes configuration unavoidable.
- If configuration is genuinely required, keep it narrow and explicit, document the reason, and do not add speculative options for hypothetical future use.

## Interface changes
- Prefer hard cuts. We own the callers, so update them directly instead of adding compatibility aliases, legacy keys, shim layers, or dual-surface migrations.

## Repository decisions
- Keep active behavioral and architectural rules in this file so they are read before implementation work.
- Document implementation-specific behavior in the relevant repository docs when it materially affects operation or maintenance.
