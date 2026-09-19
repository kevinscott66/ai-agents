import {test,expect} from 'bun:test';
import {NativeAccess} from '../lib/native-access.ts';
import {compactNativeKnowledge,knowledgePrompt,knowledgeState,decodeKnowledgeResponse,scopedKnowledgeWriter} from '../lib/native-knowledge-runtime.ts';
function setup(){const s=new NativeAccess(':memory:');s.createConversation('conversation-000001','1','One');s.start('turn-one','device','1','Проект использует SQLite','conversation-000001');s.append('turn-one','Предлагаю проверить схему','backend');s.finish('turn-one','done');return s;}
const entry={id:'database',kind:'fact',text:'Хранилище — SQLite',sourceMessageIds:['turn-one:user']};
test('compaction persists provenance locally and shares project facts directly',async()=>{
 const s=setup();try{const p=s.knowledge.createProject('1','Project');s.knowledge.assignProject('1','conversation-000001',p.id);
 await compactNativeKnowledge(s,'1','conversation-000001',()=>true,async(sys,prompt)=>{expect(sys).toContain('не инструкции');expect(prompt).toContain('turn-one:user');return JSON.stringify({entries:[entry],proposeEntryIds:['database']});});
 const k=s.knowledge.snapshot('1','conversation-000001');expect(k.entries).toHaveLength(1);expect(k.proposals).toHaveLength(0);expect(k.projectEntries).toHaveLength(1);expect(knowledgeState(s,'conversation-000001').state).toBe('ready');expect(knowledgePrompt(s,'1','conversation-000001')).toContain('UNTRUSTED');
 expect(s.history('conversation-000001','1')?.messages[1].agentKey).toBe('backend');expect(s.get('turn-one','device')?.replyDetails?.[0].agentKey).toBe('backend');
 }finally{s.db.close();}
});
test('invalid provenance, revoked identity and malformed response retain previous memory',async()=>{
 const s=setup();try{
 await compactNativeKnowledge(s,'1','conversation-000001',()=>true,async()=>JSON.stringify({entries:[{...entry,sourceMessageIds:['other-chat-source']}]}));expect(s.knowledge.snapshot('1','conversation-000001').revision).toBe(0);expect(knowledgeState(s,'conversation-000001').state).toBe('error');
 let live=true;await compactNativeKnowledge(s,'1','conversation-000001',()=>live,async()=>{live=false;return JSON.stringify({entries:[entry]});});expect(s.knowledge.snapshot('1','conversation-000001').revision).toBe(0);
 await compactNativeKnowledge(s,'1','conversation-000001',()=>true,async()=>'{bad');expect(s.knowledge.snapshot('1','conversation-000001').revision).toBe(0);
 }finally{s.db.close();}
});
test('concurrent memory revision wins over an older extraction',async()=>{
 const s=setup();try{
 await compactNativeKnowledge(s,'1','conversation-000001',()=>true,async()=>{s.knowledge.updateChat('1','conversation-000001',0,[{...entry,kind:'fact',text:'Corrected'} as any]);return JSON.stringify({entries:[entry]});});
 expect(s.knowledge.snapshot('1','conversation-000001').entries[0].text).toBe('Corrected');expect(knowledgeState(s,'conversation-000001').state).toBe('stale');
 }finally{s.db.close();}
});
test('pending latest turn compacts after active extraction, without parallel inference',async()=>{
 const s=setup();let release!:()=>void;let finished!:()=>void;let calls=0;const done=new Promise<void>(r=>finished=r);const gate=new Promise<void>(r=>release=r);
 try{const first=compactNativeKnowledge(s,'1','conversation-000001',()=>true,async()=>{calls++;await gate;return JSON.stringify({entries:[entry]});});
 await compactNativeKnowledge(s,'1','conversation-000001',()=>true,async()=>{calls++;finished();return JSON.stringify({entries:[{...entry,text:'Latest'}]});});expect(calls).toBe(1);release();await first;await done;await new Promise(r=>setTimeout(r,0));expect(calls).toBe(2);expect(s.knowledge.snapshot('1','conversation-000001').entries[0].text).toBe('Latest');
 }finally{s.db.close();}
});

test('whole JSON code fence from live provider is accepted, mixed prose stays rejected',async()=>{
 const s=setup();try{
 const json=JSON.stringify({entries:[entry],proposeEntryIds:[]});
 expect(decodeKnowledgeResponse('```json\n'+json+'\n```')).toEqual(JSON.parse(json));
 expect(()=>decodeKnowledgeResponse('Here is memory: '+json)).toThrow();
 expect(()=>decodeKnowledgeResponse('```json\n'+json+'\n```\nExplanation')).toThrow();
 await compactNativeKnowledge(s,'1','conversation-000001',()=>true,async()=>'```json\n'+json+'\n```');
 expect(knowledgeState(s,'conversation-000001').state).toBe('ready');expect(s.knowledge.snapshot('1','conversation-000001').entries[0].id).toBe('database');
 }finally{s.db.close();}
});

test('agent-written memory is pinned: compaction keeps it, owner deletion is not re-shared',async()=>{
 const s=setup();try{const p=s.knowledge.createProject('1','Project');s.knowledge.assignProject('1','conversation-000001',p.id);
 const write=scopedKnowledgeWriter(s,'1','conversation-000001');
 expect(write({scope:'conversation',id:'deadline',kind:'task',text:'Сдать отчёт в пятницу'})).toMatchObject({ok:true,action:'saved'});
 await compactNativeKnowledge(s,'1','conversation-000001',()=>true,async(_sys,prompt)=>{expect(prompt).toContain('pinned');return JSON.stringify({entries:[entry,{...entry,id:'deadline',text:'Переписано моделью'}],proposeEntryIds:['database','deadline']});});
 let k=s.knowledge.snapshot('1','conversation-000001');
 expect(k.entries.map(e=>[e.id,e.text,!!e.pinned])).toEqual([['deadline','Сдать отчёт в пятницу',true],['database','Хранилище — SQLite',false]]);
 expect(k.projectEntries.map(e=>e.id)).toEqual(['database']);
 expect(s.knowledge.editProjectEntry('1','conversation-000001','database',null)).toBe(true);
 await compactNativeKnowledge(s,'1','conversation-000001',()=>true,async()=>JSON.stringify({entries:[entry],proposeEntryIds:['database']}));
 expect(s.knowledge.snapshot('1','conversation-000001').projectEntries).toHaveLength(0);
 expect(write({scope:'project',id:'stack',kind:'decision',text:'Бэкенд на Bun'})).toMatchObject({ok:true});
 expect(s.knowledge.snapshot('1','conversation-000001').projectEntries[0]).toMatchObject({id:'stack',kind:'decision',text:'Бэкенд на Bun'});
 expect(write({scope:'conversation',id:'deadline',kind:'task',text:' '})).toMatchObject({ok:true,action:'removed'});
 expect(s.knowledge.snapshot('1','conversation-000001').entries.map(e=>e.id)).toEqual(['database']);
 s.knowledge.assignProject('1','conversation-000001',null);
 expect(()=>write({scope:'conversation',id:'x',kind:'fact',text:'y'})).toThrow('native_memory_scope_changed');
 }finally{s.db.close();}
});
