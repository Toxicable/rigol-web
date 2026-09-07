from pathlib import Path

registry = Path('src/server/instruments/instrument-registry.ts')
text = registry.read_text(encoding='utf-8')
old = '  subscriberAdded?: () => void | Promise<void>;\n  subscribers: Set<object>;'
new = '  subscriberAdded: (() => void | Promise<void>) | undefined;\n  subscribers: Set<object>;'
if text.count(old) != 1:
    raise RuntimeError('expected InstrumentEntry subscriberAdded declaration')
registry.write_text(text.replace(old, new), encoding='utf-8')

gateway = Path('src/server/websocket/websocket-gateway.ts')
text = gateway.read_text(encoding='utf-8')
for unused in ['  type DmmReadingSnapshot,\n', '  type DmmState,\n']:
    if unused not in text:
        raise RuntimeError(f'missing expected gateway import: {unused!r}')
    text = text.replace(unused, '')
gateway.write_text(text, encoding='utf-8')

print('Stream A typecheck fixes applied')
