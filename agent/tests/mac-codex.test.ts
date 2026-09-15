import {test,expect} from 'bun:test';
import {parseBridgeMsg} from '../mac-daemon/protocol.ts';
import {codexCommand} from '../mac-daemon/codex-command.ts';
import {createAuthGate} from '../mac-daemon/auth-gate.ts';
import {toMacSession} from '../miniapp/src/lib/mac-session.ts';
test('Codex frame selects Codex and remains behind authentication gate',()=>{
 const msg=parseBridgeMsg(JSON.stringify({type:'run_codex',id:'id',project:'/p',prompt:'test',mode:'auto'}));
 expect(msg).toMatchObject({type:'run',provider:'codex',mode:'auto'});
 const gate=createAuthGate();expect(gate.accepts(msg)).toBe(false);gate.markAuthenticated();expect(gate.accepts(msg)).toBe(true);
 expect(parseBridgeMsg(JSON.stringify({type:'run',id:'id',project:'/p',prompt:'test'}))).toEqual({type:'run',id:'id',project:'/p',prompt:'test',mode:'ask'});
 expect(parseBridgeMsg(JSON.stringify({type:'run_codex',id:'id',project:'/p',prompt:'test',mode:'bypass'}))?.type).toBe('bad_run');
});
test('Codex argv never bypasses sandbox and prompt cannot inject flags',()=>{
 for(const mode of ['ask','plan','accept_edits','auto'] as const){
  const argv=codexCommand(mode,{});expect(argv[0]).toBe('codex');expect(argv.at(-1)).toBe('-');
  expect(argv[argv.indexOf('--sandbox')+1]).toBe(mode==='ask'||mode==='plan'?'read-only':'workspace-write');
  expect(argv).toContain('approval_policy="never"');expect(argv).toContain('--ignore-user-config');
  expect(argv).not.toContain('--dangerously-bypass-approvals-and-sandbox');
 }
 expect(()=>codexCommand('bypass',{})).toThrow();
 expect(codexCommand('plan',{CODEX_BIN:'  '})[0]).toBe('codex');
});
test('session history labels new provider and keeps legacy Claude',()=>{
 const action={id:'1',status:'ok',created_at:1,payload:{project:'/p',provider:'codex'},result:{}} as any;
 expect(toMacSession(action).provider).toBe('codex');
 expect(toMacSession({...action,payload:{project:'/p'}}).provider).toBe('claude');
 expect(toMacSession({...action,payload:'hidden'}).provider).toBeUndefined();
});

test('server sends separate Codex frame instead of legacy Claude run',async()=>{
 const {sendToMac,_setActiveSocketForTests}=await import('../lib/mac-bridge.ts');
 const frames:string[]=[];_setActiveSocketForTests({send:(text:string)=>{frames.push(text);}});
 try {
  const result=sendToMac({provider:'codex',project:'/x',prompt:'check',mode:'plan'}).catch(()=>null);
  expect(JSON.parse(frames[0]).type).toBe('run_codex');
  expect(parseBridgeMsg(frames[0])).toMatchObject({provider:'codex',prompt:'check'});
  _setActiveSocketForTests(null);await result;
 } finally {_setActiveSocketForTests(null);}
});
