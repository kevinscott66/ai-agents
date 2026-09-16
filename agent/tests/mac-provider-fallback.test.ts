import { test, expect } from 'bun:test';
import { spawnWithFallback } from '../mac-daemon/provider-fallback.ts';
import { parseBridgeMsg } from '../mac-daemon/protocol.ts';
const missing = Object.assign(new Error('missing'), { code: 'ENOENT' });

test('legacy request stays opt-out; explicit fallback flag is strict', () => {
 const base = {type:'run',id:'r',project:'/tmp',prompt:'test'};
 expect(parseBridgeMsg(JSON.stringify(base))).not.toHaveProperty('allowFallback');
 expect(parseBridgeMsg(JSON.stringify({...base,allowFallback:true}))).toMatchObject({allowFallback:true});
 for (const value of ['true',1,null,{}]) expect(parseBridgeMsg(JSON.stringify({...base,allowFallback:value}))).toMatchObject({type:'bad_run'});
});

test('only missing executable before any child exists selects alternate exactly once', () => {
 const attempts:string[]=[];
 const child = { exited: Promise.resolve(1), stdout:'authentication failed' };
 const result = spawnWithFallback('claude','ask',true,provider=>{
  attempts.push(provider); if(provider==='claude')throw missing; return child;
 },()=>true);
 expect(attempts).toEqual(['claude','codex']);
 expect(result).toEqual({child,metadata:{provider:'codex',requestedProvider:'claude',fallbackReason:'executable_not_found'}});
});

test('spawn success never inspects exit, auth errors, output, timeout or cancellation to replay',async () => {
 let calls=0;const child={exited:Promise.resolve(1),stdout:'not logged in',cancelled:true};
 const result=spawnWithFallback('claude','auto',true,()=>{calls++;return child;},()=>{throw new Error('must not inspect');});
 await child.exited;expect(calls).toBe(1);expect(result).toHaveProperty('child',child);
});

test('unknown errors, permission failures, existing binaries, and legacy calls cannot fallback', () => {
 for (const [error,enabled,isMissing] of [[missing,undefined,true],[missing,false,true],[missing,true,false],[new Error('ENOENT'),true,true],[{code:'EACCES'},true,true],[{code:'EPERM'},true,true]] as const) {
  let calls=0;spawnWithFallback('claude','ask',enabled,()=>{calls++;throw error;},()=>isMissing);expect(calls).toBe(1);
 }
});

test('sandbox mismatch and bypass explicitly block fallback', () => {
 for(const mode of ['ask','plan','accept_edits','auto'] as const){
  let calls=0;const result=spawnWithFallback('codex',mode,true,()=>{calls++;throw missing;},()=>true);
  expect(calls).toBe(1);expect(result.metadata.fallbackBlocked).toBe('permission_mismatch');
 }
 expect(spawnWithFallback('claude','bypass',true,()=>{throw missing;},()=>true).metadata.fallbackBlocked).toBe('bypass_mode');
});

test('alternate spawn failure reports alternate and never cycles providers',()=>{
 let calls=0;const result=spawnWithFallback('claude','plan',true,()=>{calls++;throw missing;},()=>true);
 expect(calls).toBe(2);expect(result).toMatchObject({error:missing,metadata:{provider:'codex',requestedProvider:'claude',fallbackReason:'executable_not_found'}});
});

test('real Bun missing-executable exception triggers fallback, missing cwd does not',()=>{
 for(const cwdMissing of [false,true]){
  let calls=0;
  const binary=cwdMissing?'/bin/echo':'/tmp/agent-nonexistent-fallback-test-932874';
  const result=spawnWithFallback('claude','ask',true,provider=>{
   calls++;if(provider==='codex')return 'alternate';
   return Bun.spawn({cmd:[binary],...(cwdMissing?{cwd:'/tmp/agent-nonexistent-cwd-test-932874'}:{})});
  },()=>Bun.which(binary)===null);
  expect(calls).toBe(cwdMissing?1:2);
  expect('child' in result).toBe(!cwdMissing);
 }
});
