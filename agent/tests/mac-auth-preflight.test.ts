import {test,expect} from 'bun:test';
import {probeClaudeAuth, type AuthProbeChild} from '../mac-daemon/auth-preflight.ts';

function fixture(text:string, wait=false, exitCode=0) {
 const child=Bun.spawn({cmd:[process.execPath,'-e',`process.stdout.write(${JSON.stringify(text)});${wait?'setInterval(()=>{},1000)':`process.exitCode=${exitCode}`}`],stdin:'ignore',stdout:'pipe',stderr:'ignore',detached:true});
 const probe:AuthProbeChild={stdout:child.stdout,exited:child.exited,kill:s=>child.kill(s),processGroupId:child.pid};
 return {child,probe};
}
for(const [output,result] of [['{"loggedIn":false}','unavailable'],['{"loggedIn":true}','available'],['not logged in','unknown'],['{"loggedIn":"false"}','unknown'],['{}','unknown'],['null','unknown'],['{','unknown']] as const){
 test(`auth probe accepts only exact JSON boolean: ${output}`,async()=>{
  const {probe}=fixture(output);let tracked=false;
  expect(await probeClaudeAuth(()=>probe,new AbortController().signal,()=>{tracked=true;})).toBe(result);
  expect(tracked).toBe(true);
 });
}
test('timeout cannot declare unavailable from incomplete output; child is killed',async()=>{
 const {child,probe}=fixture('{"loggedIn":false}',true);
 expect(await probeClaudeAuth(()=>probe,new AbortController().signal,()=>{},50)).toBe('unknown');
 await child.exited;expect(child.signalCode).toBeTruthy();
});
test('oversized auth output is unknown and bounded',async()=>{
 const {child,probe}=fixture('x'.repeat(17000),true);
 expect(await probeClaudeAuth(()=>probe,new AbortController().signal,()=>{})).toBe('unknown');
 await child.exited;expect(child.signalCode).toBeTruthy();
});
test('cancel tracked probe and do not authorize fallback',async()=>{
 const controller=new AbortController();const {child,probe}=fixture('{"loggedIn":false}',true);
 const pending=probeClaudeAuth(()=>probe,controller.signal,()=>{setTimeout(()=>controller.abort(),20);});
 expect(await pending).toBe('cancelled');await child.exited;expect(child.signalCode).toBeTruthy();
});
test('already cancelled probe never spawns',async()=>{
 const controller=new AbortController();controller.abort();
 expect(await probeClaudeAuth(()=>{throw new Error('must not spawn');},controller.signal,()=>{})).toBe('cancelled');
});
test('spawn error remains unknown',async()=>{
 expect(await probeClaudeAuth(()=>{throw Object.assign(new Error('missing'),{code:'ENOENT'});},new AbortController().signal,()=>{})).toBe('unknown');
});

test('logged-out status 1 is valid but unexpected exit failure is unknown',async()=>{
 for(const code of [1,2]) {
  const {probe}=fixture('{"loggedIn":false}',false,code);
  expect(await probeClaudeAuth(()=>probe,new AbortController().signal,()=>{})).toBe(code===1?'unavailable':'unknown');
 }
});
