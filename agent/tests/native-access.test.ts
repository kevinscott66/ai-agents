import { test, expect, afterEach } from 'bun:test';
import { NativeAccess } from '../lib/native-access.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const stores: NativeAccess[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.db.close(); });
function memory() { const s = new NativeAccess(':memory:'); stores.push(s); return s; }
test('pairing code is single use, credentials stored only as hashes, revocable', () => {
  const s = memory(); const code = s.pair('12'); const paired = s.redeem(code)!;
  expect(paired.userId).toBe('12'); expect(s.redeem(code)).toBeNull();
  expect(s.authenticate(paired.token)?.userId).toBe('12');
  expect(JSON.stringify(s.db.query('SELECT * FROM devices').all())).not.toContain(paired.token);
  s.revoke('12'); expect(s.authenticate(paired.token)).toBeNull();
});
test('expired code is rejected', () => {
  const s = memory(); const code = s.pair('12'); s.db.run('UPDATE codes SET expires=0'); expect(s.redeem(code)).toBeNull();
});
test('same id is idempotent; different text/device conflicts; only one running turn per owner', () => {
  const s = memory();
  expect(s.start('id1', 'deviceA', '12', 'open')).toBe('created');
  expect(s.start('id1', 'deviceA', '12', 'open')).toBe('duplicate');
  expect(s.start('id1', 'deviceA', '12', 'different')).toBe('conflict');
  expect(s.start('id1', 'deviceB', '12', 'open')).toBe('conflict');
  expect(s.start('id2', 'deviceB', '12', 'next')).toBe('busy');
  s.append('id1', 'result'); expect(s.get('id1', 'deviceB')).toBeNull();
  expect(s.get('id1', 'deviceA')?.replies).toEqual(['result']);
  s.finish('id1', 'done'); expect(s.start('id2', 'deviceB', '12', 'next')).toBe('created');
});
test('restart preserves replies and marks unfinished work interrupted without replay', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-native-test-'));
  try {
    const path = join(dir, 'native.db');
    const first = new NativeAccess(path); first.start('job', 'device', '12', 'do work'); first.append('job', 'partial'); first.db.close();
    const second = new NativeAccess(path);
    expect(second.get('job', 'device')).toEqual({ id: 'job', status: 'interrupted', replies: ['partial'] });
    second.db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
