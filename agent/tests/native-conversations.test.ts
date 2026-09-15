import { createHash } from 'node:crypto';
import { test, expect } from 'bun:test';
import { NativeAccess } from '../lib/native-access.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('conversation ownership, devices, idempotency and archive retention', () => {
 const s = new NativeAccess(':memory:');
 try {
  s.createConversation('dialog-0000000001','1','One'); s.createConversation('dialog-0000000002','2','Two');
  expect(s.conversations('1')).toHaveLength(1);
  expect(s.history('dialog-0000000001','2')).toBeNull();
  expect(s.createConversation('dialog-0000000001','2','Hijack')).toBeNull();
  expect(s.start('turn-000000000001','deviceB','2','bad','dialog-0000000001')).toBe('conflict');
  expect(s.start('turn-000000000001','deviceA','1','hello','dialog-0000000001')).toBe('created');
  expect(s.start('turn-000000000001','deviceA','1','hello','dialog-0000000001')).toBe('duplicate');
  expect(s.start('turn-000000000002','other-device','1','hello','dialog-0000000001')).toBe('busy');
  s.append('turn-000000000001','answer'); s.finish('turn-000000000001','done');
  expect(s.get('turn-000000000001','other-device')).toBeNull();
  expect(s.history('dialog-0000000001','1')!.messages.map(m => m.text)).toEqual(['hello','answer']);
  s.prune(Date.now()+8*86400000);
  expect(s.history('dialog-0000000001','1')!.messages).toHaveLength(2);
  expect(s.start('turn-000000000001','deviceA','1','hello','dialog-0000000001')).toBe('conflict');
 } finally { s.db.close(); }
});
test('history pagination has no gaps', () => {
 const s = new NativeAccess(':memory:');
 try {
  s.createConversation('dialog-0000000001','1','One');
  for(let i=0;i<110;i++) { const id = 'turn-'+i; s.start(id,'d','1',String(i),'dialog-0000000001'); s.append(id,'reply'); s.finish(id,'done'); }
  const first = s.history('dialog-0000000001','1')!;
  const second = s.history('dialog-0000000001','1',first.messages[0].seq)!;
  const third = s.history('dialog-0000000001','1',second.messages[0].seq)!;
  expect(first.more && second.more && !third.more).toBe(true);
  expect(new Set([...first.messages,...second.messages,...third.messages].map(m=>m.id)).size).toBe(220);
 } finally { s.db.close(); }
});
test('restart migrates legacy turns once without replay', () => {
 const dir = mkdtempSync(join(tmpdir(),'native-history-')); const path=join(dir,'native.db');
 try {
  const first=new NativeAccess(path);
  const collision='legacy-'+createHash('sha256').update('1').digest('hex').slice(0,32);
  first.createConversation(collision,'attacker','Claimed');
  // Simulate a pre-archive database; current start() already creates its archive.
  first.db.query("INSERT INTO turns(id,device,user_id,text,status,replies,created) VALUES(?,?,?,?,'running',?,?)").run('legacy-turn-00001','d','1','legacy',JSON.stringify(['answer']),Date.now());
  first.db.close();
  const second=new NativeAccess(path); const conversation=second.conversations('1')[0] as {id:string};
  expect(second.history(conversation.id,'1')!.messages).toHaveLength(2);
  expect(second.history(collision,'attacker')!.messages).toHaveLength(0);
  expect(second.get('legacy-turn-00001','d')?.status).toBe('interrupted'); second.db.close();
  const third=new NativeAccess(path); expect(third.history(conversation.id,'1')!.messages).toHaveLength(2); third.db.close();
 } finally { rmSync(dir,{recursive:true,force:true}); }
});
