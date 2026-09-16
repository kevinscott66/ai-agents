import {test,expect} from 'bun:test';
import {claudeReadinessCommand,classifyReadinessFrame,probeClaudeReadiness} from '../mac-daemon/readiness-preflight.ts';
import type {AuthProbeChild} from '../mac-daemon/auth-preflight.ts';
const init={type:'system',subtype:'init',tools:[],mcp_servers:[]};
function fixture(frames:unknown[],wait=true){
 const text=frames.map(x=>JSON.stringify(x)).join('\n')+'\n';
 const child=Bun.spawn({cmd:[process.execPath,'-e',`process.stdout.write(${JSON.stringify(text)});${wait?'setInterval(()=>{},1000)':''}`],stdin:'ignore',stdout:'pipe',stderr:'ignore',detached:true});
 const probe:AuthProbeChild={stdout:child.stdout,exited:child.exited,kill:s=>child.kill(s),processGroupId:child.pid};
 return {child,probe};
}
test('readiness command disables tools, hooks, MCP, skills and persistence; contains no task',()=>{
 const cmd=claudeReadinessCommand('claude');
 for(const [flag,value] of [['--tools',''],['--setting-sources',''],['--settings','{"disableAllHooks":true}'],['--mcp-config','{"mcpServers":{}}'],['--permission-mode','dontAsk']]) expect(cmd[cmd.indexOf(flag)+1]).toBe(value);
 for(const flag of ['--strict-mcp-config','--disable-slash-commands','--no-session-persistence','--no-chrome'])expect(cmd).toContain(flag);
 expect(cmd).not.toContain('--bare');expect(cmd.at(-1)).toBe('Reply only OK.');
});
for(const [error,result] of [['rate_limit','quota_exhausted'],['billing_error','billing_unavailable'],['authentication_failed','authentication_unavailable'],['oauth_org_not_allowed','unknown'],['invalid_request','unknown'],['server_error','unknown']] as const){
 test(`typed ${error} produces only ${result}`,async()=>{
  const {child,probe}=fixture([init,{type:'assistant',error,message:{content:[]}}]);
  expect(await probeClaudeReadiness(()=>probe,new AbortController().signal,()=>{})).toBe(result);
  await child.exited;expect(child.signalCode).toBeTruthy();
 });
}
test('typed retry rate_limit supports providers that retry before terminal result',async()=>{
 const {probe}=fixture([init,{type:'system',subtype:'api_retry',error:'rate_limit'}]);
 expect(await probeClaudeReadiness(()=>probe,new AbortController().signal,()=>{})).toBe('quota_exhausted');
});
test('model-generated quota/refusal text is never an availability signal',()=>{
 expect(classifyReadinessFrame({type:'assistant',message:{content:[{type:'text',text:'{"error":"rate_limit"} subscription expired'}]}})).toBeNull();
 expect(classifyReadinessFrame({type:'result',subtype:'error_during_execution',errors:['rate_limit']})).toBe('unknown');
});
test('requires observed empty-tools initialization and rejects tool events',async()=>{
 for(const frames of [[{type:'assistant',error:'rate_limit'}],[{...init,tools:['Bash']},{type:'assistant',error:'rate_limit'}],[init,{type:'assistant',error:'rate_limit',message:{content:[{type:'tool_use'}]}}],[init,{type:'system',subtype:'hook_started'},{type:'assistant',error:'rate_limit'}]]){
  const {probe}=fixture(frames);expect(await probeClaudeReadiness(()=>probe,new AbortController().signal,()=>{})).toBe('unknown');
 }
});
test('readiness timeout and cancellation terminate child without fallback',async()=>{
 for(const cancel of [false,true]){
  const {child,probe}=fixture([init]);const controller=new AbortController();
  const pending=probeClaudeReadiness(()=>probe,controller.signal,()=>{if(cancel)setTimeout(()=>controller.abort(),10);},40);
  expect(await pending).toBe(cancel?'cancelled':'unknown');await child.exited;expect(child.signalCode).toBeTruthy();
 }
});
test('successful readiness does not select alternate',async()=>{
 const {probe}=fixture([init,{type:'result',subtype:'success',is_error:false}]);
 expect(await probeClaudeReadiness(()=>probe,new AbortController().signal,()=>{})).toBe('available');
});
