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
test('messages carry their time; old databases gain the column', () => {
 const dir = mkdtempSync(join(tmpdir(),'native-time-')); const path=join(dir,'native.db');
 try {
  const { Database } = require('bun:sqlite');
  const old = new Database(path);
  old.run("CREATE TABLE conversations(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,title TEXT NOT NULL,created INTEGER NOT NULL,updated INTEGER NOT NULL); CREATE TABLE conversation_messages(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,conversation_id TEXT NOT NULL,role TEXT NOT NULL,text TEXT NOT NULL); INSERT INTO conversations VALUES('dialog-0000000001','1','Old',1,1); INSERT INTO conversation_messages(id,conversation_id,role,text) VALUES('old:user','dialog-0000000001','user','before');");
  old.close();
  const s = new NativeAccess(path);
  const before = Date.now();
  s.start('turn-000000000001','d','1','hello','dialog-0000000001'); s.append('turn-000000000001','answer');
  s.appendConversationReply('1','dialog-0000000001','team','researcher');
  const messages = s.history('dialog-0000000001','1')!.messages as {text:string;created?:number}[];
  expect(messages[0]).not.toHaveProperty('created');
  for (const m of messages.slice(1)) { expect(m.created).toBeGreaterThanOrEqual(before - 1000); expect(m.created).toBeLessThanOrEqual(Date.now() + 1000); }
  expect(messages.map(m => m.text)).toEqual(['before','hello','answer','team']);
  s.db.close();
 } finally { rmSync(dir,{recursive:true,force:true}); }
});
test('rename, archive and delete stay within the owner', () => {
 const s = new NativeAccess(':memory:');
 try {
  s.createConversation('dialog-0000000001','1','One'); s.createConversation('dialog-0000000002','1','Two');
  expect(s.editConversation('dialog-0000000001','2',{title:'Hijack'})).toBeNull();
  expect(s.editConversation('dialog-0000000001','1',{title:'  Renamed  '})!.title).toBe('Renamed');
  s.editConversation('dialog-0000000001','1',{archived:true});
  expect(s.conversations('1').map(c => c.id)).toEqual(['dialog-0000000002']);
  expect(s.conversations('1',undefined,200,true).map(c => c.id)).toEqual(['dialog-0000000001']);
  s.editConversation('dialog-0000000001','1',{archived:false});
  expect(s.conversations('1')).toHaveLength(2);
  s.start('turn-000000000001','d','1','hello','dialog-0000000002');
  expect(s.deleteConversation('dialog-0000000002','1')).toBe('busy');
  s.append('turn-000000000001','answer'); s.finish('turn-000000000001','done');
  expect(s.deleteConversation('dialog-0000000002','2')).toBeNull();
  expect(s.deleteConversation('dialog-0000000002','1')).toBe('deleted');
  expect(s.history('dialog-0000000002','1')).toBeNull();
  expect(s.db.query("SELECT COUNT(*) AS n FROM conversation_messages WHERE conversation_id='dialog-0000000002'").get()).toEqual({n:0});
  expect(s.conversations('1').map(c => c.id)).toEqual(['dialog-0000000001']);
 } finally { s.db.close(); }
});
test('deleting a conversation removes its turns, attachments and coordinates, not the neighbour\'s', () => {
 const s = new NativeAccess(':memory:');
 const upload = (id:string) => ({id,name:'a.txt',mimeType:'text/plain',size:3,data:Buffer.from('abc'),text:'',previews:[]});
 try {
  s.createConversation('dialog-0000000001','1','Keep'); s.createConversation('dialog-0000000002','1','Drop');
  const keep='11111111-1111-1111-1111-111111111111', drop='22222222-2222-2222-2222-222222222222';
  s.media.put('1',upload(keep)); s.media.put('1',upload(drop));
  const where={latitude:55.7,longitude:37.6};
  for (const [t,c,a] of [['turn-000000000001','dialog-0000000001',keep],['turn-000000000002','dialog-0000000002',drop]]) {
   expect(s.start(t,'d','1','hi',c,[a],where)).toBe('created'); s.append(t,'answer'); s.finish(t,'done');
  }
  const usage = () => (s.db.query("SELECT COALESCE(SUM(cost),0) n FROM native_attachments WHERE user_id='1'").get() as {n:number}).n;
  const before = usage();
  expect(s.deleteConversation('dialog-0000000002','1')).toBe('deleted');
  expect(s.get('turn-000000000002','d')).toBeNull();
  expect(s.media.get(drop,'1')).toBeNull();
  expect(usage()).toBeLessThan(before);
  for (const table of ['native_turn_media','conversation_turns','native_output_media','turns'])
   expect(s.db.query(`SELECT COUNT(*) n FROM ${table} WHERE ${table==='turns'?'id':'turn_id'}='turn-000000000002'`).get()).toEqual({n:0});
  expect(s.get('turn-000000000001','d')!.replies).toEqual(['answer']);
  expect(s.media.get(keep,'1')).not.toBeNull();
  expect(s.db.query("SELECT COUNT(*) n FROM native_turn_media WHERE turn_id='turn-000000000001'").get()).toEqual({n:1});
 } finally { s.db.close(); }
});
