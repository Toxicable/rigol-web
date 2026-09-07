from pathlib import Path

path = Path('src/server/scope-runtime.test.ts')
text = path.read_text(encoding='utf-8')
old = '''      expect(second.info.serialNumber).toBe("FAKE-2");
      expect(second.controller).not.toBe(first.controller);

      await expect(first.controller.executeRawScpi(":SYSTem:ERRor?")).rejects.toThrow();
      await delay(20);
      expect(fake.connections[1]?.commands).not.toContain(":SYSTem:ERRor?");'''
new = '''      expect(second.info.serialNumber).toBe("FAKE-2");
      expect(Object.keys(first).sort()).toEqual(["info", "kind", "state"]);
      expect(Object.keys(second).sort()).toEqual(["info", "kind", "state"]);'''
if text.count(old) != 1:
    raise RuntimeError('expected stale-controller assertion block exactly once')
text = text.replace(old, new)
text = text.replace('reconnects with a fresh session and never reuses a stale controller', 'reconnects with fresh data-only connection state')
path.write_text(text, encoding='utf-8')
