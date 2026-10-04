/** Official read-only GitHub MCP; fixed endpoint/repository, never generic dispatch. */
import { repo } from './github.ts';
import { isAssistantOwner } from './assistant-auth.ts';
import { scrubSecretString } from './log.ts';
const ENDPOINT='https://api.githubcopilot.com/mcp/readonly';
export function githubMcpConfigured(){return process.env.GITHUB_MCP_ENABLED==='true' && !!process.env.GITHUB_READ_TOKEN;}
export function personalToolOwner(ctx:{agentKey:string;chatId:number;triggerUserId?:string}){
 return ctx.agentKey==='orchestrator' && !!ctx.triggerUserId && String(ctx.chatId)===ctx.triggerUserId && isAssistantOwner(ctx.triggerUserId);
}
async function readReply(response:Response,id:number){
 if(!response.body)throw Error('mcp_empty_response');
 const reader=response.body.getReader();let size=0,text='';const decoder=new TextDecoder();
 const sse=response.headers.get('content-type')?.includes('text/event-stream');
 const validate=(reply:any)=>{if(reply?.jsonrpc!=='2.0'||reply.id!==id||reply.error||!reply.result)throw Error('mcp_protocol_error');return reply.result;};
 try{while(true){
  const r=await reader.read();if(r.done)break;size+=r.value.length;if(size>524288)throw Error('mcp_response_too_large');
  text+=decoder.decode(r.value,{stream:true});
  if(sse){
   text=text.replace(/\r\n/g,'\n');let end:number;
   while((end=text.indexOf('\n\n'))>=0){
    const event=text.slice(0,end);text=text.slice(end+2);
    const data=event.split('\n').filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trimStart()).join('\n');
    if(!data)continue;let reply:any;try{reply=JSON.parse(data);}catch{throw Error('mcp_protocol_error');}
    if(reply.id===id)return validate(reply);
   }
  }
 }
 if(sse)throw Error('mcp_protocol_error');
 return validate(JSON.parse(text+decoder.decode()));
 }finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
}
export async function readGithubMcp(input:Record<string,unknown>,ctx:{agentKey:string;chatId:number;triggerUserId?:string},send:typeof fetch=fetch){
 if(!personalToolOwner(ctx))return {ok:false,error:'owner_private_chat_required'};
 if(!githubMcpConfigured())return {ok:false,error:'github_mcp_not_configured'};
 const [owner,repository]=repo().split('/');
 let name:string,args:Record<string,unknown>={owner,repo:repository};
 if(input.operation==='file'){
  if(typeof input.path!=='string'||input.path.length>1000||input.path.startsWith('/')||input.path.split('/').some(x=>!x||x==='..')||/[\x00-\x1f\x7f]/.test(input.path))return {ok:false,error:'invalid_path'};
  if(input.ref!==undefined&&(typeof input.ref!=='string'||input.ref.length>200||!input.ref||/[\x00-\x1f\x7f]/.test(input.ref)))return {ok:false,error:'invalid_ref'};
  name='get_file_contents';args={...args,path:input.path,...(input.ref?{ref:input.ref}:{})};
 }else if(input.operation==='issue'||input.operation==='pull_request'){
  if(!Number.isSafeInteger(input.number)||Number(input.number)<1)return {ok:false,error:'invalid_number'};
  name=input.operation==='issue'?'issue_read':'pull_request_read';args={...args,method:'get',[input.operation==='issue'?'issue_number':'pullNumber']:input.number};
 }else return {ok:false,error:'invalid_operation'};
 let sequence=0,session:string|undefined;const signal=AbortSignal.timeout(30000);
 const rpc=async(method:string,params:Record<string,unknown>,notification=false)=>{
  if(!personalToolOwner(ctx)||!githubMcpConfigured())throw Error('mcp_access_changed');
  const id=++sequence;
  const response=await send(ENDPOINT,{method:'POST',redirect:'error',signal,headers:{Authorization:'Bearer '+process.env.GITHUB_READ_TOKEN,'Content-Type':'application/json',Accept:'application/json, text/event-stream','MCP-Protocol-Version':'2025-03-26','X-MCP-Readonly':'true','X-MCP-Tools':'get_file_contents,issue_read,pull_request_read',...(session?{'Mcp-Session-Id':session}:{})},body:JSON.stringify({jsonrpc:'2.0',...(notification?{}:{id}),method,params})});
  if(!response.ok){await response.body?.cancel();throw Error(response.status===401?'mcp_auth_required':'mcp_http_error');}
  session=response.headers.get('mcp-session-id')??session;
  if(notification){await response.body?.cancel();return;}
  return readReply(response,id);
 };
 try{
  const init=await rpc('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'dobropalm-agent',version:'1.0'}});
  if(init.protocolVersion!=='2025-03-26')throw Error('mcp_protocol_version');
  await rpc('notifications/initialized',{},true);
  const result=await rpc('tools/call',{name,arguments:args});
  if(!personalToolOwner(ctx)||!githubMcpConfigured())throw Error('mcp_access_changed');
  const content=scrubSecretString(JSON.stringify(result.content??[]));
  return {ok:result.isError!==true,source:'github-mcp',untrusted:true,truncated:content.length>40000,content:content.slice(0,40000),...(result.isError?{error:'mcp_tool_error'}:{})};
 }catch(error){const code=error instanceof Error?error.message:'';return {ok:false,error:/^mcp_[a-z_]+$/.test(code)?code:'mcp_unavailable'};}
}
