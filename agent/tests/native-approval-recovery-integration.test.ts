import {test,expect,spyOn} from 'bun:test';
import {NativeAccess} from '../lib/native-access.ts';
import {nativeApi,configureNativeLead} from '../lib/native-api.ts';
import {gateOrDispatch} from '../lib/action-dispatch.ts';
import {nativeApprovalLinks} from '../lib/native-context.ts';
import {decideApproval} from '../lib/approvals.ts';
import {logAction} from '../lib/audit.ts';
import {db} from '../lib/db.ts';
import {setPermission} from '../lib/permissions.ts';
import {savePermissions} from './_helpers.ts';

test('native gate link and audited result recover after archive write failure without execution replay', async () => {
  const user='998561237', other='998561238';
  const envKeys=['NATIVE_APP_ENABLED','MAC_USER_IDS','TELEGRAM_ALLOWED_GROUP_IDS','MINIAPP_ADMIN_USER_IDS'];
  const saved=Object.fromEntries(envKeys.map(key=>[key,process.env[key]]));
  Object.assign(process.env,{NATIVE_APP_ENABLED:'true',MAC_USER_IDS:`${user},${other}`,TELEGRAM_ALLOWED_GROUP_IDS:`${user},${other}`,MINIAPP_ADMIN_USER_IDS:`${user},${other}`});
  const restorePerms=savePermissions([['orchestrator','MAC_RUN_CLAUDE']]);
  setPermission('orchestrator','MAC_RUN_CLAUDE',{allowed:true,requires_approval:true});
  const store=new NativeAccess(':memory:');
  const dialog='integration-dialog-00001', turn='integration-turn-000001';
  store.createConversation(dialog,user,'Approval');
  const token=store.redeem(store.pair(user))!.token;
  const otherToken=store.redeem(store.pair(other))!.token;
  let runs=0, approvalId='';
  const restoreLead=configureNativeLead(async (_user,_text,reply)=>{
    runs++;
    const result=await gateOrDispatch('MAC_RUN_CLAUDE',{project:'/tmp/native-fixture',prompt:'fixture',mode:'ask',_userId:user} as never,{agentKey:'orchestrator',chatId:Number(user),triggerUserId:user});
    expect(result.kind).toBe('pending_approval');
    if(result.kind !== 'pending_approval') throw new Error(JSON.stringify(result));
    approvalId=result.approvalId;
    reply('Awaiting approval');
  });
  const linkFailure=spyOn(store,'linkApproval').mockImplementation(()=>{throw new Error('simulated archive disk failure');});
  const get=(who=token)=>nativeApi(new Request(`https://agent.test/api/native/conversations/${dialog}/approvals`,{headers:{authorization:`Bearer ${who}`}}),store);
  try {
    const sent=await nativeApi(new Request('https://agent.test/api/native/turns',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({id:turn,text:'Run fixture',conversationId:dialog})}),store);
    expect(sent.status).toBe(202);
    for(let i=0;i<50 && store.running(user);i++) await Bun.sleep(2);
    expect(approvalId.length).toBeGreaterThan(0);
    expect(nativeApprovalLinks(db,user,dialog).map(row=>row.approval_id)).toContain(approvalId);
    expect(store.conversationApprovals(dialog,user)).toEqual([]);
    linkFailure.mockRestore();
    expect((await get(otherToken)).status).toBe(404);
    process.env.MINIAPP_ADMIN_USER_IDS=other;
    expect((await get()).status).toBe(403);
    process.env.MINIAPP_ADMIN_USER_IDS=`${user},${other}`;
    const pending=await get();
    expect(pending.status).toBe(200);
    expect((await pending.json() as any).approvals[0].id).toBe(approvalId);
    expect(store.conversationApprovals(dialog,user)).toHaveLength(1);
    decideApproval(approvalId,'approved','fixture');
    logAction({agentKey:'orchestrator',chatId:Number(user),actionType:'MAC_RUN_CLAUDE',payload:{},status:'ok',result:{approvalId,output:'Recovered existing execution'}});
    for(let i=0;i<2;i++) {
      const recovered=await get();
      expect(recovered.status).toBe(200);
      expect((await recovered.json() as any).approvals[0].execution).toBe('completed');
    }
    expect(store.history(dialog,user)!.messages.filter(m=>m.text === 'Recovered existing execution')).toHaveLength(1);
    // A committed main-DB terminal record also repairs an unavailable archive,
    // independently of the action audit fallback and without re-running tools.
    store.db.query('DELETE FROM conversation_approvals WHERE approval_id=?').run(approvalId);
    store.db.query('DELETE FROM conversation_messages WHERE id=?').run('approval:'+approvalId+':result');
    db.query("UPDATE native_approval_links SET execution='completed',output=? WHERE approval_id=?").run('Durable completion',approvalId);
    db.query("DELETE FROM agent_actions WHERE chat_id=? AND status='ok'").run(Number(user));
    expect((await get()).status).toBe(200);
    expect(store.history(dialog,user)!.messages.at(-1)?.text).toBe('Durable completion');
    expect(store.conversationApprovals(dialog,user)![0].execution).toBe('completed');
    expect(runs).toBe(1);
  } finally {
    linkFailure.mockRestore(); restoreLead(); restorePerms(); store.db.close();
    db.query('DELETE FROM approvals WHERE chat_id=?').run(Number(user));
    db.query('DELETE FROM agent_actions WHERE chat_id=?').run(Number(user));
    if(db.query("SELECT 1 FROM sqlite_master WHERE name='native_approval_links'").get()) db.query('DELETE FROM native_approval_links WHERE user_id=?').run(user);
    for(const [key,value] of Object.entries(saved)) {if(value===undefined) delete process.env[key]; else process.env[key]=value;}
  }
});
