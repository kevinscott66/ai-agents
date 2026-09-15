import {afterEach, expect, test} from 'bun:test';
import {authNonce, authProof, createDaemonHandshake} from '../mac-daemon/auth-handshake.ts';
import {parseBridgeMsg} from '../mac-daemon/protocol.ts';
import {_handleClientMessageForTests as feed, _setActiveSocketForTests, isMacConnected, sendToMac, stopMac} from '../lib/mac-bridge.ts';
const secret = 'fixture-mutual-auth-secret-32-characters';
const previous = process.env.MAC_BRIDGE_SECRET;
afterEach(() => {
  _setActiveSocketForTests(null);
  if (previous === undefined) delete process.env.MAC_BRIDGE_SECRET; else process.env.MAC_BRIDGE_SECRET = previous;
});
function socket() {
  process.env.MAC_BRIDGE_SECRET = secret;
  return {data: {authed:false,peerKey:'fixture'}, sent:[] as any[], closed:false,
    send(raw:string){this.sent.push(JSON.parse(raw));}, close(){this.closed=true;}};
}
test('mutual authentication uses actual bridge handler and never transmits shared secret', () => {
  const ws=socket(), daemon=createDaemonHandshake(secret);
  feed(ws,JSON.stringify(daemon.hello));
  expect(ws.data.authed).toBe(false);
  const challenge=parseBridgeMsg(JSON.stringify(ws.sent[0]));
  expect(challenge?.type).toBe('auth_challenge'); if(challenge?.type!=='auth_challenge')throw Error('challenge');
  const response=daemon.challenge(challenge); expect(response).not.toBeNull();
  feed(ws,JSON.stringify(response));
  expect(ws.data.authed).toBe(true);expect(isMacConnected()).toBe(true);
  expect(daemon.accept(ws.sent[1].proof)).toBe(true);
  expect(daemon.accept(ws.sent[1].proof)).toBe(false);
  expect(JSON.stringify([daemon.hello,response,...ws.sent])).not.toContain(secret);
});
test('new daemon rejects forged legacy auth_ok and wrong server proof', () => {
  const daemon=createDaemonHandshake(secret);
  expect(daemon.accept(undefined)).toBe(false);
  expect(daemon.challenge({serverNonce:authNonce(),proof:'0'.repeat(64)})).toBeNull();
});
test('server rejects a reflected server proof and legacy downgrade after hello', () => {
  for(const downgrade of [false,true]) {
    const ws=socket(), daemon=createDaemonHandshake(secret);
    feed(ws,JSON.stringify(daemon.hello));
    feed(ws,JSON.stringify(downgrade ? {type:'auth',secret} : {type:'auth_proof',proof:ws.sent[0].proof}));
    expect(ws.closed).toBe(true);expect(ws.data.authed).toBe(false);
  }
});
test('proofs cannot replay across server or daemon connections', () => {
  const first=socket(), daemon=createDaemonHandshake(secret);
  feed(first,JSON.stringify(daemon.hello));const proof=daemon.challenge(first.sent[0]);
  const second=socket();feed(second,JSON.stringify(daemon.hello));
  feed(second,JSON.stringify(proof));expect(second.closed).toBe(true);expect(second.data.authed).toBe(false);
  expect(createDaemonHandshake(secret).challenge(first.sent[0])).toBeNull();
  const accepted=authProof(secret,'accepted',daemon.hello.clientNonce,first.sent[0].serverNonce);
  expect(createDaemonHandshake(secret).accept(accepted)).toBe(false);
});
test('server retains legacy clients for server-first deployment', () => {
  const ws=socket();feed(ws,JSON.stringify({type:'auth',secret}));
  expect(ws.data.authed).toBe(true);expect(ws.sent[0]).toEqual({type:'auth_ok'});
});

test('actual run and stop frames reject injection, tampering, replay and cross-connection substitution', async () => {
  const ws=socket(), daemon=createDaemonHandshake(secret);
  feed(ws,JSON.stringify(daemon.hello));const response=daemon.challenge(ws.sent[0]);
  feed(ws,JSON.stringify(response));expect(daemon.accept(ws.sent[1].proof)).toBe(true);
  const result=sendToMac({project:'/fixture',prompt:'harmless fixture',mode:'plan',provider:'codex'}).catch(()=>null);
  const signed=ws.sent[2];expect(signed.type).toBe('signed');
  expect(daemon.unwrap(JSON.stringify({type:'run',project:'/fixture',prompt:'injected',mode:'bypass'}))).toBeNull();
  expect(daemon.unwrap(JSON.stringify({...signed,body:signed.body.replace('plan','bypass')}))).toBeNull();
  expect(daemon.unwrap(JSON.stringify({...signed,sequence:2}))).toBeNull();
  expect(JSON.parse(daemon.unwrap(JSON.stringify(signed))!)).toMatchObject({type:'run_codex',mode:'plan'});
  expect(daemon.unwrap(JSON.stringify(signed))).toBeNull();
  await stopMac();
  expect(JSON.parse(daemon.unwrap(JSON.stringify(ws.sent[3]))!)).toEqual({type:'stop'});
  const other=createDaemonHandshake(secret), nonce=authNonce();
  other.challenge({serverNonce:nonce,proof:authProof(secret,'server',other.hello.clientNonce,nonce)});
  other.accept(authProof(secret,'accepted',other.hello.clientNonce,nonce));
  expect(other.unwrap(JSON.stringify(signed))).toBeNull();await result;
});

test('signed result and stream reach bridge; altered, replayed and reflected responses fail closed', async () => {
  for (const attack of ['tamper','replay','reflect','unsigned'] as const) {
    const ws=socket(), daemon=createDaemonHandshake(secret);
    feed(ws,JSON.stringify(daemon.hello));feed(ws,JSON.stringify(daemon.challenge(ws.sent[0])));
    expect(daemon.accept(ws.sent[1].proof)).toBe(true);
    const result=sendToMac({project:'/fixture',prompt:'fixture',mode:'plan'}).catch(()=>null);
    const command=JSON.parse(daemon.unwrap(JSON.stringify(ws.sent[2]))!);
    const chunk=daemon.wrap(JSON.stringify({type:'chunk',id:command.id,stream:'stdout',data:'verified output'}))!;
    feed(ws,JSON.stringify(chunk));expect(ws.closed).toBe(false);
    const forged=attack==='tamper' ? {...daemon.wrap(JSON.stringify({type:'result',id:command.id,ok:false}))!,body:JSON.stringify({type:'result',id:command.id,ok:true})}
      : attack==='replay' ? chunk : attack==='reflect' ? ws.sent[2] : {type:'result',id:command.id,ok:true};
    feed(ws,JSON.stringify(forged));expect(ws.closed).toBe(true);
    _setActiveSocketForTests(null);await result;
  }
  const ws=socket(), daemon=createDaemonHandshake(secret);
  feed(ws,JSON.stringify(daemon.hello));feed(ws,JSON.stringify(daemon.challenge(ws.sent[0])));daemon.accept(ws.sent[1].proof);
  const result=sendToMac({project:'/fixture',prompt:'fixture',mode:'plan'});
  const command=JSON.parse(daemon.unwrap(JSON.stringify(ws.sent[2]))!);
  feed(ws,JSON.stringify(daemon.wrap(JSON.stringify({type:'chunk',id:command.id,stream:'stdout',data:'verified output'}))));
  feed(ws,JSON.stringify(daemon.wrap(JSON.stringify({type:'result',id:command.id,ok:true,code:0}))));
  expect(await result).toMatchObject({ok:true,stdout:'verified output'});
});
test('strict rollout mode refuses legacy raw-secret auth', () => {
  const saved=process.env.MAC_BRIDGE_ALLOW_LEGACY_AUTH;
  try {
    process.env.MAC_BRIDGE_ALLOW_LEGACY_AUTH='false';
    const ws=socket();feed(ws,JSON.stringify({type:'auth',secret}));
    expect(ws.closed).toBe(true);expect(ws.data.authed).toBe(false);
  } finally {if(saved===undefined)delete process.env.MAC_BRIDGE_ALLOW_LEGACY_AUTH;else process.env.MAC_BRIDGE_ALLOW_LEGACY_AUTH=saved;}
});
