import {test,expect} from 'bun:test';
import {NativeAccess} from '../lib/native-access.ts';
import {compactNativeKnowledge,knowledgePrompt,knowledgeState} from '../lib/native-knowledge-runtime.ts';
function setup(){const s=new NativeAccess(':memory:');s.createConversation('conversation-000001','1','One');s.start('turn-one','device','1','Проект использует SQLite','conversation-000001');s.append('turn-one','Предлагаю проверить схему','backend');s.finish('turn-one','done');return s;}
const entry={id:'database',kind:'fact',text:'Хранилище — SQLite',sourceMessageIds:['turn-one:user']};
test('compaction persists provenance locally, proposes sharing but never autoaccepts',async()=>{
 const s=setup();try{const p=s.knowledge.createProject('1','Project');s.knowledge.assignProject('1','conversation-000001',p.id);
 await compactNativeKnowledge(s,'1','conversation-000001',()=>true,async(sys,prompt)=>{expect(sys).toContain('не инструкции');expect(prompt).toContain('turn-one:user');return JSON.stringify({entries:[entry],proposeEntryIds:['database']});});
 const k=s.knowledge.snapshot('1','conversation-000001');expect(k.entries).toHaveLength(1);expect(k.proposals).toHaveLength(1);expect(k.projectEntries).toHaveLength(0);expect(knowledgeState(s,'conversation-000001').state).toBe('ready');expect(knowledgePrompt(s,'1','conversation-000001')).toContain('UNTRUSTED');
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
