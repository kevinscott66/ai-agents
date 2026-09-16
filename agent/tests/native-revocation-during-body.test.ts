import {test,expect,spyOn} from 'bun:test';
import {NativeAccess,nativeAccess} from '../lib/native-access.ts';
import {nativeApi,configureNativeLead} from '../lib/native-api.ts';
import {startMiniappServer} from '../lib/miniapp-server.ts';
import {createApproval,getApproval} from '../lib/approvals.ts';
import {db} from '../lib/db.ts';

const user='998161991';
function configure() {
  const keys=['NATIVE_APP_ENABLED','MAC_USER_IDS','TELEGRAM_ALLOWED_GROUP_IDS'];
  const saved=keys.map(key=>process.env[key]);
  Object.assign(process.env,{NATIVE_APP_ENABLED:'true',MAC_USER_IDS:user,TELEGRAM_ALLOWED_GROUP_IDS:user});
  return ()=>keys.forEach((key,i)=>{if(saved[i]===undefined) delete process.env[key]; else process.env[key]=saved[i];});
}
test('native turn cannot start with credentials revoked while its body was arriving', async()=>{
  const restore=configure(); const store=new NativeAccess(':memory:'); let runs=0;
  const restoreLead=configureNativeLead(async()=>{runs++;});
  try {
    const token=store.redeem(store.pair(user))!.token;
    let controller!:ReadableStreamDefaultController<Uint8Array>;
    const body=new ReadableStream<Uint8Array>({start(c){controller=c;}});
    const response=nativeApi(new Request('https://test/api/native/turns',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body}),store);
    store.revoke(user);
    controller.enqueue(new TextEncoder().encode(JSON.stringify({id:'revoked-turn-00001',text:'must not run'}))); controller.close();
    expect((await response).status).toBe(401);
    await Bun.sleep(0);
    expect(runs).toBe(0);
    expect(store.conversations(user)).toEqual([]);
  } finally {restoreLead();store.db.close();restore();}
});

test('native panel cannot decide an approval after revocation during its streamed body', async()=>{
  const restore=configure(); const store=nativeAccess();
  const token=store.redeem(store.pair(user))!.token;
  const approval=createApproval({actionId:crypto.randomUUID(),chatId:Number(user),requestedBy:'qa',actionType:'SEND_MESSAGE',payload:{text:'must stay pending'}});
  const server=startMiniappServer({port:0,botToken:'fixture',allowedUserIds:[Number(user)],adminUserIds:[Number(user)]});
  let authenticated!:()=>void;
  const initialAuth=new Promise<void>(resolve=>{authenticated=resolve;});
  const original=store.authenticate.bind(store);
  const spy=spyOn(store,'authenticate').mockImplementation(value=>{const identity=original(value);if(value===token && identity) authenticated();return identity;});
  let controller!:ReadableStreamDefaultController<Uint8Array>;
  const body=new ReadableStream<Uint8Array>({start(c){controller=c;c.enqueue(new TextEncoder().encode('{"decision":'));}});
  let request:Promise<Response>|undefined;
  try {
    request=fetch(`http://127.0.0.1:${server.port}/api/approvals/${approval.id}/decide`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body});
    await Promise.race([initialAuth,Bun.sleep(2000).then(()=>{throw new Error('server did not authenticate initial headers');})]);
    store.revoke(user);
    controller.enqueue(new TextEncoder().encode('"approved"}'));controller.close();
    expect((await request).status).toBe(401);
    expect(getApproval(approval.id)?.status).toBe('pending');
  } finally {
    try {controller.close();} catch {}
    await request?.catch(()=>{});
    spy.mockRestore();server.stop();store.revoke(user);
    db.query('DELETE FROM approvals WHERE id=?').run(approval.id);
    restore();
  }
});
