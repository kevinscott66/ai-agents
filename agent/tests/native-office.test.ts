import {test,expect} from 'bun:test';
import {NativeAccess} from '../lib/native-access';
import {nativeApi,configureNativeLead} from '../lib/native-api';
import {configureNativeRole,officeRoles} from '../lib/native-roles';
const owner='999323908',other='999323909';
test('office direct roles are owner scoped, durable, idempotent and share owner concurrency',async()=>{
 const names=['NATIVE_APP_ENABLED','NATIVE_OFFICE_ENABLED','MAC_USER_IDS','TELEGRAM_ALLOWED_GROUP_IDS'];const saved=Object.fromEntries(names.map(k=>[k,process.env[k]]));
 Object.assign(process.env,{NATIVE_APP_ENABLED:'true',NATIVE_OFFICE_ENABLED:'true',MAC_USER_IDS:owner+','+other,TELEGRAM_ALLOWED_GROUP_IDS:owner+','+other});
 const store=new NativeAccess(':memory:');const pair=store.redeem(store.pair(owner))!,pair2=store.redeem(store.pair(other))!;
 let runs=0,release:()=>void=()=>{};const wait=new Promise<void>(r=>release=r);
 const restore=configureNativeRole('backend',async(_,text,reply)=>{runs++;await wait;reply('Backend: '+text);});
 const lead=configureNativeLead(async()=>{throw new Error('wrong dispatch');});
 const req=(path:string,body?:unknown,token=pair.token)=>new Request('https://office.test/api/native/'+path,{method:body?'POST':'GET',headers:{authorization:'Bearer '+token,...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
 const post=async(body:unknown)=>nativeApi(req('turns',body),store);
 try{
  expect((await nativeApi(req('office',undefined,''),store)).status).toBe(401);
  const snapshot=await (await nativeApi(req('office'),store)).json() as any;expect(snapshot.agents).toHaveLength(12);expect(snapshot.agents.filter((a:any)=>a.available).map((a:any)=>a.agentId)).toEqual(['backend']);
  const conversationId=crypto.randomUUID(),id=crypto.randomUUID();await nativeApi(req('conversations',{id:conversationId,title:'Backend'}),store);
  const command={id,conversationId,agentKey:'backend',text:'hello'};
  expect((await post({...command,agentKey:'invented'})).status).toBe(400);
  expect((await post({...command,agentKey:null})).status).toBe(400);
  expect((await post(command)).status).toBe(202);await Promise.resolve();
  expect((await post(command)).status).toBe(202);expect(runs).toBe(1);
  expect(store.start(id,store.authenticate(pair.token)!.device,owner,'hello',conversationId,[],undefined,'frontend')).toBe('conflict');
  expect((await post({...command,id:crypto.randomUUID()})).status).toBe(409);
  expect((await nativeApi(req('turns/'+id,undefined,pair2.token),store)).status).toBe(404);
  const foreign=await(await nativeApi(req('office',undefined,pair2.token),store)).json() as any;expect(foreign.agents.every((a:any)=>a.runId===null&&a.conversationId===null)).toBe(true);
  const current=await(await nativeApi(req('office'),store)).json() as any;expect(current.agents.find((a:any)=>a.agentId==='backend').state).toBe('THINKING');
  release();await new Promise(r=>setTimeout(r,20));
  const turn=await(await nativeApi(req('turns/'+id),store)).json() as any;expect(turn.status).toBe('done');expect(turn.replyDetails[0].agentKey).toBe('backend');
  expect((await post({id:crypto.randomUUID(),conversationId,text:'wrong role default'})).status).toBe(409);
  process.env.NATIVE_OFFICE_ENABLED='false';expect((await post({...command,id:crypto.randomUUID()})).status).toBe(503);process.env.NATIVE_OFFICE_ENABLED='true';
  store.revoke(owner);expect((await nativeApi(req('office'),store)).status).toBe(401);
 }finally{release();restore();lead();store.db.close();for(const [k,v]of Object.entries(saved)){if(v===undefined)delete process.env[k];else process.env[k]=v;}}
});
test('all canonical roles can be registered independently',()=>{expect(new Set(officeRoles.map(r=>r.key)).size).toBe(12);});
test('deleted role bindings cannot contaminate a recreated conversation',()=>{
 const store=new NativeAccess(':memory:');try{
 const id=crypto.randomUUID(),turn=crypto.randomUUID();store.createConversation(id,owner,'Backend');
 expect(store.start(turn,'device',owner,'hello',id,[],undefined,'backend')).toBe('created');store.finish(turn,'done');
 expect(store.deleteConversation(id,owner)).toBe('deleted');store.createConversation(id,other,'Lead');
 expect(store.start(crypto.randomUUID(),'other-device',other,'hello',id)).toBe('created');
 expect(store.officeTurns(owner)).toEqual([]);
 }finally{store.db.close();}
});
test('role binding and uncertain turn state survive process restart without redispatch',()=>{
 const {mkdtempSync,rmSync}=require('node:fs'),{join}=require('node:path'),{tmpdir}=require('node:os');
 const dir=mkdtempSync(join(tmpdir(),'office-binding-')),path=join(dir,'native.db'),id=crypto.randomUUID(),chat=crypto.randomUUID();
 let store=new NativeAccess(path);try{store.createConversation(chat,owner,'QA');expect(store.start(id,'device',owner,'check',chat,[],undefined,'qa')).toBe('created');store.db.close();store=new NativeAccess(path);
 expect(store.get(id,'device')?.status).toBe('interrupted');expect(store.start(id,'device',owner,'check',chat,[],undefined,'qa')).toBe('duplicate');expect(store.start(crypto.randomUUID(),'device',owner,'check',chat)).toBe('conflict');
 }finally{store.db.close();rmSync(dir,{recursive:true,force:true});}
});
