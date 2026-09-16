import {test,expect} from 'bun:test';
import {nativeAccess} from '../lib/native-access.ts';
import {nativeTurnContext,persistNativeApprovalLink} from '../lib/native-context.ts';
import {executeApproved,buildApprovalExecDeps} from '../lib/commands.ts';
import {createApproval,decideApproval} from '../lib/approvals.ts';
import {setAutonomy} from '../lib/permissions.ts';
import {CHARACTERS} from '../characters/index.ts';
import {db} from '../lib/db.ts';
import {cleanupChat} from './_helpers.ts';

test('approved native delegation restores owned conversation transport and specialist history',async()=>{
 const user='999323915';const dialog='approved-team-owned-915',other='approved-team-other-915',turn='approved-team-turn-915';
 const saved=Object.fromEntries(['NATIVE_APP_ENABLED','MAC_USER_IDS','TELEGRAM_ALLOWED_GROUP_IDS'].map(k=>[k,process.env[k]]));
 Object.assign(process.env,{NATIVE_APP_ENABLED:'true',MAC_USER_IDS:user,TELEGRAM_ALLOWED_GROUP_IDS:user});
 const store=nativeAccess();setAutonomy('chat',user,'auto');
 const bots=['orchestrator','backend'].map((key,index)=>({def:CHARACTERS.find(c=>c.key===key)!,id:index+400,username:key+'_bot',bot:{telegram:{sendMessage:async()=>{throw new Error('Telegram forbidden');},sendChatAction:async()=>{throw new Error('Telegram forbidden');}}}} as any));
 let calls=0;
 const anthropic:any={messages:{create:async(p:any)=>{
  calls++;const messages=JSON.stringify(p.messages);expect(messages).toContain('[qa] Owned critique');expect(messages).not.toContain('OTHER_CONVERSATION_SECRET');expect(p.tool_choice?.type).not.toBe('any');
  return {id:'m',type:'message',role:'assistant',model:'test',stop_reason:'end_turn',stop_sequence:null,usage:{input_tokens:0,output_tokens:0},content:[{type:'text',text:'Backend corrected the issue'}]};
 }}};
 try{
  store.createConversation(dialog,user,'Owned');store.createConversation(other,user,'Other');store.start(turn,'fixture',user,'Discuss',dialog);store.finish(turn,'done');
  store.appendConversationReply(user,dialog,'Owned critique','qa');store.appendConversationReply(user,other,'OTHER_CONVERSATION_SECRET','backend');
  const row=createApproval({actionId:'approved-team-action-915',chatId:Number(user),requestedBy:'orchestrator',actionType:'DELEGATE_TO_ROLE',payload:{role:'backend',task:'Review the critique'} as never});
  nativeTurnContext.run({userId:user,turnId:turn,conversationId:dialog,linkApproval(){}},()=>persistNativeApprovalLink(db,row.id,Number(user)));
  const approval=decideApproval(row.id,'approved','owner');
  await executeApproved(approval,buildApprovalExecDeps({bots,handoffDeps:{bots,anthropic,model:'test',historyLimit:20}}));
  expect(calls).toBe(1);
  expect(store.history(dialog,user)!.messages.find(m=>m.text==='Backend corrected the issue')?.agentKey).toBe('backend');
  expect(store.history(other,user)!.messages).toHaveLength(1);
  expect((db.query('SELECT count(*) n FROM messages WHERE chat_id=?').get(user) as any).n).toBe(0);
  await expect(executeApproved(approval,buildApprovalExecDeps({bots,handoffDeps:{bots,anthropic,model:'test',historyLimit:20}}))).rejects.toThrow('already started');expect(calls).toBe(1);
  const revoked=createApproval({actionId:'approved-team-revoked-915',chatId:Number(user),requestedBy:'orchestrator',actionType:'DELEGATE_TO_ROLE',payload:{role:'backend',task:'Review'} as never});
  nativeTurnContext.run({userId:user,turnId:turn,conversationId:dialog,linkApproval(){}},()=>persistNativeApprovalLink(db,revoked.id,Number(user)));
  process.env.MAC_USER_IDS='';
  await expect(executeApproved(decideApproval(revoked.id,'approved','owner'),buildApprovalExecDeps({bots,handoffDeps:{bots,anthropic,model:'test',historyLimit:20}}))).rejects.toThrow('native_approval_context_unavailable');
  expect(calls).toBe(1);
 }finally{
  cleanupChat(Number(user));db.query('DELETE FROM native_approval_links WHERE user_id=?').run(user);
  store.db.query('DELETE FROM conversation_messages WHERE conversation_id IN (?,?)').run(dialog,other);store.db.query('DELETE FROM conversation_approvals WHERE turn_id=?').run(turn);store.db.query('DELETE FROM turns WHERE user_id=?').run(user);store.db.query('DELETE FROM conversations WHERE user_id=?').run(user);
  for(const[k,v]of Object.entries(saved)){if(v===undefined)delete process.env[k];else process.env[k]=v;}
 }
});
