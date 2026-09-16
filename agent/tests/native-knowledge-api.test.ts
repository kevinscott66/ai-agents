import {test,expect} from 'bun:test';
import {NativeAccess} from '../lib/native-access.ts';
import {nativeApi} from '../lib/native-api.ts';
import {nativeTurnContext} from '../lib/native-context.ts';
import {executeTool} from '../lib/tools-schema.ts';
const user='999323908',other='999323909';
test('native project/knowledge API uses device owner, explicit assignment and explicit approval',async()=>{
 const old={NATIVE_APP_ENABLED:process.env.NATIVE_APP_ENABLED,MAC_USER_IDS:process.env.MAC_USER_IDS,TELEGRAM_ALLOWED_GROUP_IDS:process.env.TELEGRAM_ALLOWED_GROUP_IDS};Object.assign(process.env,{NATIVE_APP_ENABLED:'true',MAC_USER_IDS:`${user},${other}`,TELEGRAM_ALLOWED_GROUP_IDS:`${user},${other}`});
 const s=new NativeAccess(':memory:');const a=s.redeem(s.pair(user))!,b=s.redeem(s.pair(other))!;
 const request=(path:string,token=a.token,body?:unknown)=>nativeApi(new Request('https://test/api/native/'+path,{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer '+token,...(body!==undefined?{'content-type':'application/json'}:{})},body:body===undefined?undefined:JSON.stringify(body)}),s);
 try {
 const chat='conversation-api-0001';s.createConversation(chat,user,'A');s.start('source','device',user,'Use SQLite',chat);s.finish('source','done');
 const response=await request('projects',a.token,{title:'Project'});expect(response.status).toBe(201);const {project}=await response.json() as any;
 expect((await request('conversations/'+chat+'/project',a.token,{projectId:project.id})).status).toBe(200);
 expect((await request('conversations/'+chat+'/knowledge',b.token)).status).toBe(404);
 expect((await (await request('projects',b.token)).json() as any).projects).toEqual([]);
 s.knowledge.updateChat(user,chat,0,[{id:'db',kind:'fact',text:'SQLite',sourceMessageIds:['source:user']}]);
 const {proposal}=await (await request('conversations/'+chat+'/proposals',a.token,{entryId:'db'})).json() as any;
 expect((await request('knowledge/proposals/'+proposal.id,b.token,{accept:true})).status).toBe(409);
 expect(s.knowledge.snapshot(user,chat).projectEntries).toHaveLength(0);
 expect((await request('knowledge/proposals/'+proposal.id,a.token,{accept:'yes'})).status).toBe(400);
 expect((await request('knowledge/proposals/'+proposal.id,a.token,{accept:true})).status).toBe(200);
 expect(s.knowledge.snapshot(user,chat).projectEntries[0].text).toBe('SQLite');
 s.revoke(user);expect((await request('conversations/'+chat+'/knowledge')).status).toBe(401);
 }finally{s.db.close();for(const [k,v] of Object.entries(old)){if(v===undefined)delete process.env[k];else process.env[k]=v;}}
});
test('native wiki tools cannot access or mutate global wiki',async()=>{
 const result=await nativeTurnContext.run({userId:user,turnId:'t',conversationId:'c',knowledge:'ONLY CURRENT CHAT',linkApproval:()=>{}},async()=>{
 const ctx={agentKey:'orchestrator',chatId:Number(user)} as any;
 return [await executeTool('SEARCH_WIKI',{query:'all secrets'},ctx),await executeTool('READ_WIKI',{scope:'_team',slug:'project'},ctx),await executeTool('WRITE_WIKI',{scope:'_team',slug:'project',content:'overwrite'},ctx)];
 });
 expect(result[0]).toContain('ONLY CURRENT CHAT');expect(result[1]).toContain('ONLY CURRENT CHAT');expect(result[2]).toContain('автоматически');
});
