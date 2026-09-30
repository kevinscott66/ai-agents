import { test, expect } from 'bun:test';
import { RemoteRelay, type RemoteIdentity } from '../lib/native-remote.ts';
const host = { userId: 'owner', device: 'mac' }, viewer = { userId: 'owner', device: 'phone' }, other = { userId: 'outsider', device: 'other' };
const frame = Buffer.from([255,216,0,0,255,217]).toString('base64');
function setup() {
  let time = 1000; const revoked = new Set<string>();
  const relay = new RemoteRelay({ now: () => time });
  const live = (who: RemoteIdentity) => () => !revoked.has(who.device);
  const request = (path: string, body?: unknown, headers = {}) => new Request('https://agent.test/api/native/remote' + path, { method: body === undefined ? 'GET' : 'POST', headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const call = (who: RemoteIdentity, path: string, body?: unknown, headers = {}) => relay.handle(request(path, body, headers), who, live(who));
  const json = async (who: RemoteIdentity, path: string, body?: unknown) => { const response = await call(who, path, body); expect(response.status).toBe(200); return response.json() as Promise<any>; };
  const pair = async () => {
    const h = await json(host, '/host', { name: 'Mac', control: true }); const s = await json(viewer, '/request', { host: h.host });
    await json(host, '/host/accept', { session: s.session }); return { h, id: s.session as string };
  };
  return { relay, live, request, call, json, pair, revoked, advance: (ms: number) => { time += ms; } };
}
test('remote relay binds hosts/sessions to actual owner and device, consent, consuming input', async () => {
  const s = setup(); const h = await s.json(host, '/host', { device: 'spoof', userId: 'outsider', control: true });
  expect((await s.json(other, '/hosts')).hosts).toEqual([]);
  expect((await s.call(other, '/request', { host: h.host })).status).toBe(404);
  const pending = await s.json(viewer, '/request', { host: h.host }); const id = pending.session;
  expect((await s.call(viewer, '/host/accept', { session: id })).status).toBe(404);
  expect((await s.call(viewer, `/session/${id}/input`, { kind: 'click', x: 0, y: 0, frameID: 1 })).status).toBe(409);
  expect((await s.call({ userId: 'owner', device: 'second' }, '/request', { host: h.host })).status).toBe(409);
  expect((await s.json(host, '/host/poll')).session.status).toBe('pending');
  await s.json(host, '/host/accept', { session: id });
  expect((await s.call(host, `/session/${id}`)).status).toBe(404);
  expect((await s.call(other, `/session/${id}`)).status).toBe(404);
  await s.json(host, '/host/frame', { session: id, frame });
  // Even a guessed correct frameID cannot be used before viewer receives it.
  expect((await s.call(viewer, `/session/${id}/input`, { kind: 'click', x: 0, y: 0, frameID: 1 })).status).toBe(409);
  expect((await s.json(viewer, `/session/${id}`)).frame).toBe(frame);
  await s.json(host, '/host/frame', { session: id, frame });
  await s.json(viewer, `/session/${id}/input`, { kind: 'click', x: 0.5, y: 1, frameID: 1 });
  const poll = await s.json(host, '/host/poll'); expect(poll.commands).toHaveLength(1); expect(poll.commands[0]).toMatchObject({ kind: 'click', frameID: 1, at: 1000 });
  expect((await s.json(host, '/host/poll')).commands).toHaveLength(0);
  await s.json(host, `/session/${id}/stop`, {});
  expect((await s.call(viewer, `/session/${id}`)).status).toBe(404);
});
test('expiry, heartbeat, max lifetime, stale frames, re-registration invalidate sessions', async () => {
  const s = setup(); let { id } = await s.pair();
  await s.json(host, '/host/frame', { session: id, frame }); await s.json(viewer, `/session/${id}`);
  s.advance(3000);
  expect((await s.call(viewer, `/session/${id}/input`, { kind: 'text', text: 'hello', frameID: 1 })).status).toBe(409);
  s.advance(12000); expect((await s.call(viewer, `/session/${id}`)).status).toBe(404);
  ({ id } = await s.pair());
  for (let i = 0; i < 3; i++) { s.advance(10000); await s.json(host, '/host/poll'); }
  expect((await s.call(viewer, `/session/${id}`)).status).toBe(404); // host traffic cannot keep absent viewer alive
  ({ id } = await s.pair());
  await s.json(host, '/host', {}); expect((await s.call(viewer, `/session/${id}`)).status).toBe(404);
  ({ id } = await s.pair());
  for (let i = 0; i < 89; i++) { s.advance(10000); await s.json(host, '/host/poll'); await s.json(viewer, `/session/${id}`); }
  s.advance(10000); await s.json(host, '/host/poll'); expect((await s.call(viewer, `/session/${id}`)).status).toBe(404);
});
test('revoking either participant kills relay and queued commands; streaming rechecks auth', async () => {
  const s = setup(); const { id } = await s.pair();
  await s.json(host, '/host/frame', { session: id, frame }); await s.json(viewer, `/session/${id}`);
  await s.json(viewer, `/session/${id}/input`, { kind: 'key', keycode: 36, modifiers: 0, frameID: 1 });
  s.revoked.add(viewer.device); const poll = await s.json(host, '/host/poll'); expect(poll.commands).toEqual([]); expect(poll.session).toBeNull();
  s.revoked.delete(viewer.device); const next = await s.json(viewer, '/request', { host: (await s.json(host, '/hosts')).hosts[0].id });
  s.revoked.add(host.device); expect((await s.call(viewer, `/session/${next.session}`)).status).toBe(404);
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{}')); controller.close(); } });
  const request = new Request('https://agent.test/api/native/remote/host', { method: 'POST', headers: { 'content-type': 'application/json' }, body: stream });
  let checks = 0;
  expect((await s.relay.handle(request, host, () => ++checks === 1)).status).toBe(401);
});
test('bounded queues, rates, input schema, native transport and JPEG limits', async () => {
  const s = setup(); const { id } = await s.pair();
  expect((await s.call(viewer, '/hosts', undefined, { origin: 'https://agent.test' })).status).toBe(403);
  expect((await s.call(viewer, '/hosts?token=secret')).status).toBe(403);
  expect((await s.call(host, '/host/frame', { session: id, frame: 'not-jpeg' })).status).toBe(400);
  expect((await s.call(host, '/host/frame', { session: id, frame: 'a'.repeat(1_400_001) })).status).toBe(413);
  await s.json(host, '/host/frame', { session: id, frame }); await s.json(viewer, `/session/${id}`);
  for (const bad of [{ kind:'click',x:2,y:0 }, { kind:'drag',x:0,y:0,endX:0 }, { kind:'key',keycode:127,modifiers:0 }, { kind:'key',keycode:2,modifiers:1 }, { kind:'scroll',delta:1001 }, { kind:'text',text:'x'.repeat(1001) }]) expect((await s.call(viewer, `/session/${id}/input`, { ...bad, frameID:1 })).status).toBe(400);
  for (let i=0;i<20;i++) await s.json(viewer, `/session/${id}/input`, { kind:'text',text:'a',frameID:1 });
  expect((await s.call(viewer, `/session/${id}/input`, { kind:'text',text:'a',frameID:1 })).status).toBe(429);
  for (let batch=0;batch<2;batch++) { s.advance(1000); for (let i=0;i<20;i++) await s.json(viewer, `/session/${id}/input`, { kind:'text',text:'a',frameID:1 }); }
  s.advance(1000); await s.json(host, '/host/frame', { session:id,frame }); await s.json(viewer, `/session/${id}`);
  for(let i=0;i<4;i++) await s.json(viewer, `/session/${id}/input`, {kind:'text',text:'a',frameID:2});
  expect((await s.call(viewer, `/session/${id}/input`, {kind:'text',text:'a',frameID:2})).status).toBe(429);
  // Old queue entries never replay after a delayed host poll.
  expect((await s.json(host, '/host/poll')).commands).toHaveLength(44);
});
test('global retained frame memory and per-owner host limits are bounded', async () => {
  const s = setup(); const bytes = Buffer.alloc(1_000_000); bytes[0]=255;bytes[1]=216;bytes[bytes.length-2]=255;bytes[bytes.length-1]=217;
  const large = bytes.toString('base64');
  for (let i=0;i<12;i++) {
    const h = {userId:'owner'+i,device:'host'+i}, v={userId:'owner'+i,device:'viewer'+i};
    const registered=await s.json(h,'/host',{control:true}), requested=await s.json(v,'/request',{host:registered.host});
    await s.json(h,'/host/accept',{session:requested.session});
    const response=await s.call(h,'/host/frame',{session:requested.session,frame:large});
    expect(response.status).toBe(i===11 ? 429 : 200);
  }
  for(let i=0;i<4;i++) await s.json({userId:'limited',device:'limited'+i},'/host',{control:true});
  expect((await s.call({userId:'limited',device:'limited4'},'/host',{control:true})).status).toBe(429);
  s.advance(15000);
  expect((await s.json({userId:'owner0',device:'viewer0'},'/hosts')).hosts).toEqual([]);
});
test('host stop requires current epoch and doubleClick remains frame/device bound', async () => {
  const s=setup(); const first=await s.json(host,'/host',{control:true}); const second=await s.json(host,'/host',{control:true});
  expect(second.epoch).not.toBe(first.epoch);
  expect((await s.call(host,'/host/stop',{epoch:first.epoch})).status).toBe(409);
  expect((await s.call(host,'/host/stop',{})).status).toBe(409);
  const pending=await s.json(viewer,'/request',{host:second.host});
  await s.json(host,'/host/accept',{session:pending.session});
  await s.json(host,'/host/frame',{session:pending.session,frame}); await s.json(viewer,`/session/${pending.session}`);
  await s.json(viewer,`/session/${pending.session}/input`,{kind:'doubleClick',x:0.3,y:0.5,frameID:1});
  expect((await s.json(host,'/host/poll')).commands[0].kind).toBe('doubleClick');
  await s.json(host,'/host/stop',{epoch:second.epoch});
  expect((await s.call(viewer,`/session/${pending.session}`)).status).toBe(404);
  expect((await s.json(viewer,'/hosts')).hosts).toEqual([]);
});
test('scroll coordinates and mouse modifiers are validated and preserved', async () => {
  const s=setup();const {id}=await s.pair();
  await s.json(host,'/host/frame',{session:id,frame});await s.json(viewer,`/session/${id}`);
  for(const invalid of [{kind:'scroll',delta:1},{kind:'scroll',delta:1,x:-1,y:0},{kind:'click',x:0,y:0,modifiers:1},{kind:'drag',x:0,y:0,endX:1,endY:1,modifiers:-1}]) {
    expect((await s.call(viewer,`/session/${id}/input`,{...invalid,frameID:1})).status).toBe(400);
  }
  for(const command of [{kind:'scroll',x:0.25,y:0.75,delta:-20,modifiers:0x20000},{kind:'click',x:0,y:1,modifiers:0x100000},{kind:'drag',x:0,y:0,endX:1,endY:1,modifiers:0x80000}]) {
    await s.json(viewer,`/session/${id}/input`,{...command,frameID:1});
    expect((await s.json(host,'/host/poll')).commands[0]).toMatchObject({...command,frameID:1});
  }
});
test('host defaults to view-only and capability is exposed without granting input', async () => {
  const s=setup();const h=await s.json(host,'/host',{});
  expect((await s.json(viewer,'/hosts')).hosts[0].control).toBe(false);
  const pending=await s.json(viewer,'/request',{host:h.host});await s.json(host,'/host/accept',{session:pending.session});
  await s.json(host,'/host/frame',{session:pending.session,frame});
  const state=await s.json(viewer,`/session/${pending.session}`);expect(state.control).toBe(false);expect(state.frame).toBe(frame);
  const denied=await s.call(viewer,`/session/${pending.session}/input`,{kind:'click',x:0,y:0,frameID:1});expect(denied.status).toBe(403);expect(await denied.json()).toEqual({error:'view_only'});
  expect((await s.json(host,'/host/poll')).commands).toEqual([]);
  expect((await s.call(host,'/host',{control:'true'})).status).toBe(400);
});
test('authorized internal HTTP request works behind trusted TLS termination', async () => {
  const s=setup();
  const request=new Request('http://127.0.0.1:3000/api/native/remote/hosts');
  expect((await s.relay.handle(request,viewer,s.live(viewer))).status).toBe(200);
  expect((await s.relay.handle(new Request(request,{headers:{origin:'https://agent.test'}}),viewer,s.live(viewer))).status).toBe(403);
});
