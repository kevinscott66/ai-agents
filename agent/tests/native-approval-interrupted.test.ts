import {test,expect} from 'bun:test';
import {NativeAccess} from '../lib/native-access.ts';
import {nativeApi} from '../lib/native-api.ts';
import {nativeTurnContext,persistNativeApprovalLink,nativeExecutionMarker,recordNativeExecutionOutcome,NATIVE_INTERRUPTED_MESSAGE} from '../lib/native-context.ts';
import {createApproval,decideApproval} from '../lib/approvals.ts';
import {logAction} from '../lib/audit.ts';
import {db} from '../lib/db.ts';

test('approval restart recovery distinguishes live execution, unknown interruption and audited success without replay',async()=>{
  const user='998161992', dialog='restart-dialog-00001';
  const keys=['NATIVE_APP_ENABLED','MAC_USER_IDS','TELEGRAM_ALLOWED_GROUP_IDS','MINIAPP_ADMIN_USER_IDS'];
  const saved=keys.map(key=>process.env[key]);
  Object.assign(process.env,{NATIVE_APP_ENABLED:'true',MAC_USER_IDS:user,TELEGRAM_ALLOWED_GROUP_IDS:user,MINIAPP_ADMIN_USER_IDS:user});
  const store=new NativeAccess(':memory:');store.createConversation(dialog,user,'Restart');
  const token=store.redeem(store.pair(user))!.token;
  const get=()=>nativeApi(new Request(`https://test/api/native/conversations/${dialog}/approvals`,{headers:{authorization:`Bearer ${token}`}}),store);
  const ids:string[]=[];
  try {
    for(const state of [null,'running:previous-boot',nativeExecutionMarker,'running:completed-old-boot']) {
      const turn='restart-turn-'+String(ids.length).padStart(8,'0');
      store.start(turn,'device',user,'fixture',dialog);store.finish(turn,'done');
      const approval=createApproval({actionId:crypto.randomUUID(),chatId:Number(user),requestedBy:'orchestrator',actionType:'MAC_RUN_CLAUDE',payload:{}});
      nativeTurnContext.run({userId:user,turnId:turn,conversationId:dialog,linkApproval:()=>{}},()=>db.transaction(()=>persistNativeApprovalLink(db,approval.id,Number(user)))());
      decideApproval(approval.id,'approved','fixture');
      db.query('UPDATE native_approval_links SET execution=? WHERE approval_id=?').run(state,approval.id);
      if(state === 'running:completed-old-boot') logAction({agentKey:'orchestrator',chatId:Number(user),actionType:'MAC_RUN_CLAUDE',payload:{},status:'ok',result:{approvalId:approval.id,output:'Audited result wins'}});
      ids.push(approval.id);
    }
    for(let attempt=0;attempt<2;attempt++) {
      const response=await get();expect(response.status).toBe(200);
      const list=(await response.json() as {approvals:{id:string;execution:string|null}[]}).approvals;
      expect(ids.map(id=>list.find(item=>item.id===id)?.execution)).toEqual(['interrupted','interrupted',null,'completed']);
    }
    const messages=store.history(dialog,user)!.messages;
    expect(messages.filter(m=>m.text===NATIVE_INTERRUPTED_MESSAGE)).toHaveLength(2);
    expect(messages.filter(m=>m.text==='Audited result wins')).toHaveLength(1);
    expect(recordNativeExecutionOutcome(db,ids[0],'failed','must not overwrite uncertainty')).toBe(false);
    expect(recordNativeExecutionOutcome(db,ids[2],'completed','Live run completed')).toBe(true);
    await get();
    expect(store.conversationApprovals(dialog,user)!.find(item=>item.approval_id===ids[2])?.execution).toBe('completed');
    expect(store.history(dialog,user)!.messages.at(-1)?.text).toBe('Live run completed');
  } finally {
    store.db.close();
    db.query('DELETE FROM approvals WHERE chat_id=?').run(Number(user));
    db.query('DELETE FROM agent_actions WHERE chat_id=?').run(Number(user));
    if(db.query("SELECT 1 FROM sqlite_master WHERE name='native_approval_links'").get()) db.query('DELETE FROM native_approval_links WHERE user_id=?').run(user);
    keys.forEach((key,i)=>{if(saved[i]===undefined) delete process.env[key];else process.env[key]=saved[i];});
  }
});
