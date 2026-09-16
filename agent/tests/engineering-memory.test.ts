import {test,expect} from 'bun:test';
import {Database} from 'bun:sqlite';
import {mkdtempSync,writeFileSync,rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {NativeKnowledge} from '../lib/native-knowledge.ts';
import {parseEngineeringBundle,ENGINEERING_ROLES,selectEngineeringEntries,type EngineeringBundle} from '../lib/engineering-memory.ts';
import {knowledgePrompt,scopedKnowledgeReader} from '../lib/native-knowledge-runtime.ts';
import {nativeTurnContext} from '../lib/native-context.ts';
import type {NativeAccess} from '../lib/native-access.ts';
import {importEngineeringCommand} from '../tools/import-engineering-memory.ts';
const bundle=():EngineeringBundle=>({version:1,batchId:'test-migration',projects:[{key:'airchat',title:'AirChat',entries:[{id:'sync',layer:'project',kind:'fact',text:'P2P sync evidence',source:{path:'docs/sync.md',sha256:'a'.repeat(64),observedAt:'2026-09-16T00:00:00Z',revision:'abc123'}}]}]});
function fixture(path=':memory:'){
 const db=new Database(path);db.run("CREATE TABLE conversations(id TEXT PRIMARY KEY,user_id TEXT,title TEXT,created INTEGER,updated INTEGER);CREATE TABLE conversation_messages(id TEXT PRIMARY KEY,conversation_id TEXT);INSERT INTO conversations VALUES('a','one','A',0,0),('b','one','B',0,0),('c','two','C',0,0)");
 return {db,k:new NativeKnowledge(db)};
}
test('import is explicit, atomic, idempotent; changed batch cannot overwrite',()=>{
 const {db,k}=fixture();try{
  expect(()=>k.engineering.importBundle('one',bundle(),false)).toThrow();
  expect(()=>k.engineering.importBundle('missing',bundle(),true)).toThrow();
  const r=k.engineering.importBundle('one',bundle(),true);expect(r.projects).toHaveLength(1);
  expect(k.engineering.importBundle('one',bundle(),true).unchanged).toBe(true);expect(k.projects('one')).toHaveLength(1);
  const changed=bundle();changed.projects[0].entries[0].text='overwrite';expect(()=>k.engineering.importBundle('one',changed,true)).toThrow('conflict');
  expect(db.query('SELECT COUNT(*) n FROM conversation_messages').get()).toEqual({n:0});
 }finally{db.close();}
});
test('all twelve roles receive only the explicitly selected owner project',async()=>{
 const {db,k}=fixture();try{
  const id=k.engineering.importBundle('one',bundle(),true).projects[0].id;
  expect(k.snapshot('one','a').importedProject).toEqual([]);k.assignProject('one','a',id);
  expect(()=>k.engineering.entries('two',id)).toThrow();expect(k.snapshot('two','c').importedProject).toEqual([]);
  const store={knowledge:k} as NativeAccess;
  const context=knowledgePrompt(store,'one','a');expect(context).toContain('UNTRUSTED');expect(context).toContain('P2P sync evidence');
  for(const role of ENGINEERING_ROLES)await nativeTurnContext.run({userId:'one',turnId:role,conversationId:'a',knowledge:context,linkApproval:()=>{}},async()=>{
   expect(nativeTurnContext.getStore()?.knowledge).toContain('P2P sync evidence');
  });
  expect(knowledgePrompt(store,'one','b')).not.toContain('P2P sync evidence');
  k.assignProject('one','a',null);expect(k.snapshot('one','a').importedProject).toEqual([]);
  k.deleteProject('one',id);expect(db.query('SELECT COUNT(*) n FROM engineering_entries').get()).toEqual({n:0});
  expect(()=>k.engineering.importBundle('one',bundle(),true)).toThrow('target_changed');
 }finally{db.close();}
});
test('no title guessing; failure rolls back all project imports',()=>{
 const {db,k}=fixture();try{
  k.createProject('one','Conflict');const b=bundle();b.projects.push({...b.projects[0],key:'second',title:'Conflict'});
  expect(()=>k.engineering.importBundle('one',b,true)).toThrow('title_conflict');expect(k.projects('one').map(x=>x.title)).toEqual(['Conflict']);
  expect(db.query('SELECT COUNT(*) n FROM engineering_imports').get()).toEqual({n:0});
 }finally{db.close();}
});
test('new batch supersedes stable IDs while retaining history and checking exact retry integrity',()=>{
 const {db,k}=fixture();try{
  const first=bundle();first.projects[0].entries.push({...first.projects[0].entries[0],id:'obsolete-tail'});
  const id=k.engineering.importBundle('one',first,true).projects[0].id;
  const newer=bundle();newer.batchId='second-batch';newer.projects[0].entries[0].text='Completed, next task is different';
  k.engineering.importBundle('one',newer,true);
  expect(k.engineering.entries('one',id)).toHaveLength(1);
  expect(k.engineering.entries('one',id)[0].text).toContain('Completed');
  expect(db.query('SELECT COUNT(*) n FROM engineering_entries').get()).toEqual({n:3});
  expect(k.engineering.importBundle('one',first,true).unchanged).toBe(true);
  db.query('UPDATE engineering_entries SET entry=? WHERE batch_id=?').run(JSON.stringify(newer.projects[0].entries[0]),first.batchId);
  expect(()=>k.engineering.importBundle('one',first,true)).toThrow('target_changed');
 }finally{db.close();}
});
test('strict parser, redaction, bounded retrieval and context',()=>{
 expect(()=>parseEngineeringBundle({...bundle(),owner:'two'})).toThrow();
 const b=bundle();b.projects[0].entries[0].text='password=never_expose';expect(parseEngineeringBundle(b).projects[0].entries[0].text).not.toContain('never_expose');
 const duplicate=bundle();duplicate.projects.push(duplicate.projects[0]);expect(()=>parseEngineeringBundle(duplicate)).toThrow();
 const {db,k}=fixture();try{
  const large=bundle();large.projects[0].entries=Array.from({length:200},(_,i)=>({...large.projects[0].entries[0],id:'e'+i,text:'content '+i+'x'.repeat(1100)}));
  const id=k.engineering.importBundle('one',large,true).projects[0].id;k.assignProject('one','a',id);
  expect(selectEngineeringEntries(k.snapshot('one','a').importedProject)).toHaveLength(8);
  expect(knowledgePrompt({knowledge:k} as NativeAccess,'one','a').length).toBeLessThan(24000);
 }finally{db.close();}
});
test('progressive query retrieves another excerpt but refuses a changed project binding',()=>{
 const {db,k}=fixture();try{
  const b=bundle();b.projects[0].entries=Array.from({length:20},(_,i)=>({...b.projects[0].entries[0],id:'e'+String(i).padStart(2,'0'),text:i===19?'specific-zebra-protocol':`ordinary fact ${i}`}));
  const id=k.engineering.importBundle('one',b,true).projects[0].id;k.assignProject('one','a',id);
  const reader=scopedKnowledgeReader({knowledge:k} as NativeAccess,'one','a');
  expect(reader('')).not.toContain('specific-zebra-protocol');expect(reader('specific-zebra-protocol')).toContain('specific-zebra-protocol');
  k.assignProject('one','a',null);expect(()=>reader('specific-zebra-protocol')).toThrow('scope_changed');
 }finally{db.close();}
});
test('operator dry-run has no writes; apply takes recoverable snapshot first',()=>{
 const dir=mkdtempSync(join(tmpdir(),'engineering-import-'));try{
  const path=join(dir,'native.db');const {db}=fixture(path);db.query("DELETE FROM conversations WHERE user_id='two'").run();db.close();
  const payload=join(dir,'bundle.json');writeFileSync(payload,JSON.stringify(bundle()));
  const args=['--db',path,'--bundle',payload,'--sole-owner'];
  const plan=importEngineeringCommand(args);expect(plan.mode).toBe('DRY_RUN');
  const backup=join(dir,'backup.db');
  const applied=importEngineeringCommand([...args,'--apply','--owner-approval','--expected-sha256',(plan as {sha256:string}).sha256,'--backup',backup]);
  expect(applied.mode).toBe('APPLIED');expect(statSync(backup).mode&0o777).toBe(0o600);
  const before=new Database(backup,{readonly:true});expect(before.query('SELECT COUNT(*) n FROM native_projects').get()).toEqual({n:0});before.close();
 }finally{rmSync(dir,{recursive:true,force:true});}
});
