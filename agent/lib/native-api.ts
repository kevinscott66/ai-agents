import { voiceApi } from './native-voice.ts';
import { signingApi } from './native-signing.ts';
import { compactNativeKnowledge, knowledgePrompt, knowledgeState, scopedKnowledgeReader } from "./native-knowledge-runtime.ts";
import { attachmentId, parseUpload, locationValue, readMediaJson, type NativeMediaInput } from './native-media.ts';
import { nativeAccess, type NativeAccess } from './native-access.ts';
import { isAssistantOwner as permitted } from './assistant-auth.ts';
import { agentStopReason } from './permissions.ts';
import { readNativeJson } from './native-request.ts';
import { db } from "./db.ts";
import { nativeTurnContext, nativeApprovalLinks, nativeExecutionMarker, isNativeExecutionOutcome, recordNativeExecutionOutcome, NATIVE_INTERRUPTED_MESSAGE } from './native-context.ts';
import { parseUserIdList } from './allowlist.ts';
import { getApproval } from './approvals.ts';
import { log, scrubSecretString } from './log.ts';

export type NativeLead = (userId: string, text: string, reply: (text: string) => void, history?: {role:string;text:string;agentKey?:string}[], media?: NativeMediaInput) => Promise<void>;
let lead: NativeLead | undefined;
const uploading = new Set<string>();
export function configureNativeLead(run: NativeLead) { const previous = lead; lead = run; return () => { lead = previous; }; }
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
export async function nativeApi(req: Request, injectedStore?: NativeAccess): Promise<Response> {
  if (process.env.NATIVE_APP_ENABLED !== 'true') return json({ error: 'native_disabled' }, 503);
  // No browser-cookie access: the native client has a device bearer token.
  if (req.headers.has('origin')) return json({ error: 'native_only' }, 403);
  const path = new URL(req.url).pathname;
  const store = injectedStore ?? nativeAccess();
  const pairing = path === '/api/native/pair' && req.method === 'POST';
  const token = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.get('authorization') || '')?.[1] || '';
  const identity = pairing ? null : store.authenticate(token);
  if (!pairing && (!identity || !permitted(identity.userId))) {
    void req.body?.cancel().catch(() => {});
    return json({ error: 'unauthorized' }, 401);
  }
  if (path.startsWith('/api/native/signing/') && identity) return signingApi(req,identity.userId,()=>process.env.NATIVE_APP_ENABLED==='true' && store.authenticate(token)?.userId===identity.userId && permitted(identity.userId));
  if (path.startsWith('/api/native/voice/') && identity) return voiceApi(req,identity.userId,()=>process.env.NATIVE_APP_ENABLED==='true' && store.authenticate(token)?.userId===identity.userId && permitted(identity.userId));
  let body: Record<string, unknown> = {};
  if (req.method === 'POST') {
    try {
      if (path === '/api/native/attachments') {
        if (!identity || uploading.has(identity.device) || uploading.size >= 2) { void req.body?.cancel().catch(()=>{}); return json({error:'upload_busy'},429); }
        uploading.add(identity.device);
        try { body = await readMediaJson(req); } finally { uploading.delete(identity.device); }
      } else body = await readNativeJson(req);
    }
    catch (error) {
      const known = new Set(['json_required', 'body_timeout', 'body_too_large', 'body_aborted']);
      const code = error instanceof Error && known.has(error.message) ? error.message : 'invalid_body';
      const status = code === 'json_required' ? 415 : code === 'body_timeout' ? 408 : code === 'body_too_large' ? 413 : 400;
      return json({ error: code }, status);
    }
  }
  if (path === '/api/native/pair' && req.method === 'POST') {
    if (typeof body?.code !== 'string' || !/^[a-f0-9]{32}$/.test(body.code)) return json({ error: 'invalid_pairing' }, 401);
    const paired = store.redeem(body.code);
    if (!paired || !permitted(paired.userId)) return json({ error: 'invalid_pairing' }, 401);
    return json(paired);
  }
  // Reading a streamed body yields: the device can be revoked or expire while
  // bytes arrive. Authorize the mutation against the live credential again.
  if (!identity || process.env.NATIVE_APP_ENABLED !== 'true' || !store.authenticate(token) || !permitted(identity.userId)) return json({ error: 'unauthorized' }, 401);
  if (path === '/api/native/attachments' && req.method === 'POST') {
    try { return json({attachment:store.media.put(identity.userId,parseUpload(body))}); }
    catch(e) { const code=e instanceof Error?e.message:''; return json({error:['media_conflict','media_quota'].includes(code)?code:'invalid_media'},code==='media_conflict'?409:code==='media_quota'?413:400); }
  }
  const download = path.match(/^\/api\/native\/attachments\/([^/]+)$/);
  if(download && req.method === 'GET') {
    const item=attachmentId.test(download[1])?store.media.get(download[1],identity.userId):null;
    if(!item) return json({error:'not_found'},404);
    const safeMime = new Set(['image/jpeg','image/png','application/pdf','video/mp4','video/quicktime','text/plain']);
    return new Response(item.data,{headers:{'Content-Type':safeMime.has(item.mimeType)?item.mimeType:'application/octet-stream','Content-Length':String(item.size),'Content-Disposition':`attachment; filename="attachment"; filename*=UTF-8''${encodeURIComponent(item.name).replace(/'/g,'%27')}`,'X-Content-Type-Options':'nosniff','Cache-Control':'no-store'}});
  }
  try {
    if(path==='/api/native/projects' && req.method==='GET')return json({projects:store.knowledge.projects(identity.userId)});
    if(path==='/api/native/projects' && req.method==='POST') {
      if(typeof body.title!=='string')return json({error:'invalid_project'},400);
      return json({project:store.knowledge.createProject(identity.userId,body.title)},201);
    }
    const knowledgeMatch=path.match(/^\/api\/native\/conversations\/([a-zA-Z0-9-]{16,64})\/(knowledge|project|proposals)$/);
    if(knowledgeMatch){
      const chat=knowledgeMatch[1];if(!store.conversation(chat,identity.userId))return json({error:'not_found'},404);
      if(knowledgeMatch[2]==='knowledge'&&req.method==='GET')return json({...store.knowledge.snapshot(identity.userId,chat),memoryState:knowledgeState(store,chat)});
      if(knowledgeMatch[2]==='project'&&req.method==='POST'){
        if(body.projectId!==null&&(typeof body.projectId!=='string'||body.projectId.length>64))return json({error:'invalid_project'},400);
        store.knowledge.assignProject(identity.userId,chat,body.projectId as string|null);
        return json(store.knowledge.snapshot(identity.userId,chat));
      }
      if(knowledgeMatch[2]==='proposals'&&req.method==='POST'){
        if(typeof body.entryId!=='string'||body.entryId.length>64)return json({error:'invalid_entry'},400);
        return json({proposal:store.knowledge.propose(identity.userId,chat,body.entryId)},201);
      }
    }
    const proposalMatch=path.match(/^\/api\/native\/knowledge\/proposals\/([a-zA-Z0-9-]{16,64})$/);
    if(proposalMatch&&req.method==='POST'){
      if(typeof body.accept!=='boolean')return json({error:'invalid_decision'},400);
      return store.knowledge.decide(identity.userId,proposalMatch[1],body.accept)?json({ok:true}):json({error:'proposal_expired'},409);
    }
  }catch(error){const code=error instanceof Error?error.message:'';return json({error:code==='knowledge_not_found'?'not_found':code==='knowledge_limit'?'knowledge_limit':'invalid_knowledge'},code==='knowledge_not_found'?404:code==='knowledge_limit'?429:400);}
  if (path === '/api/native/status' && req.method === 'GET') return json({ name: 'Агент', userId: identity.userId, available: !!lead && !agentStopReason('orchestrator') });
  if (path === '/api/native/conversations' && req.method === 'GET') {
    const cursor = new URL(req.url).searchParams.get('cursor');
    const match = cursor?.match(/^(\d{1,16}):([a-zA-Z0-9-]{16,64})$/);
    if (cursor !== null && (!match || !Number.isSafeInteger(Number(match[1])))) return json({error:'invalid_cursor'},400);
    const before = match ? {updated:Number(match[1]),id:match[2]} : undefined;
    const rows = store.conversations(identity.userId,before,201);
    const more = rows.length > 200;
    const conversations = rows.slice(0,200);
    const last = conversations.at(-1);
    return json({conversations,more,nextCursor:more && last ? `${last.updated}:${last.id}` : null,running:store.running(identity.userId)});
  }
  if (path === '/api/native/conversations' && req.method === 'POST') {
    if (typeof body.id !== 'string' || (body.id.startsWith('legacy-') && !store.conversation(body.id,identity.userId)) || !/^[a-zA-Z0-9-]{16,64}$/.test(body.id) || typeof body.title !== 'string' || !body.title.trim() || body.title.length > 100) return json({error:'invalid_conversation'},400);
    const conversation = store.createConversation(body.id,identity.userId,body.title);
    return conversation ? json({conversation}) : json({error:'not_found'},404);
  }
  const approvalsMatch = path.match(/^\/api\/native\/conversations\/([a-zA-Z0-9-]{16,64})\/approvals$/);
  if (approvalsMatch && req.method === 'GET') {
    if (!parseUserIdList(process.env.MINIAPP_ADMIN_USER_IDS).includes(Number(identity.userId))) return json({error:'forbidden'},403);
    const durableLinks = nativeApprovalLinks(db,identity.userId,approvalsMatch[1]);
    for (const link of durableLinks) {
      store.linkApproval(link.approval_id,link.turn_id,identity.userId);
      if (isNativeExecutionOutcome(link.execution)) store.recordApprovalOutcome(link.approval_id,identity.userId,link.execution,scrubSecretString(link.output ?? 'Действие завершено.'));
    }
    const links = store.conversationApprovals(approvalsMatch[1],identity.userId);
    if (!links) return json({error:'not_found'},404);
    const approvals = links.flatMap(link => {
      const approval = getApproval(link.approval_id);
      if (approval && String(approval.chat_id) === identity.userId && !link.execution) {
        if (approval.status === 'failed') {
          store.completeApproval(approval.id,identity.userId,false,'Не удалось завершить действие. Проверьте его состояние перед повтором.');
          link.execution = 'failed';
        } else if (approval.status === 'approved') {
          // Recover a result if the process stopped after auditing but before archiving.
          const action = approval.action_type === 'MAC_RUN_CLAUDE' ? db.query("SELECT result FROM agent_actions WHERE chat_id=? AND action_type='MAC_RUN_CLAUDE' AND status='ok' AND json_valid(result) AND json_extract(result,'$.approvalId')=? ORDER BY created_at DESC,rowid DESC LIMIT 1").get(approval.chat_id,approval.id) as {result:string}|null : null;
          const durable = durableLinks.find(row=>row.approval_id === approval.id);
          if (action) {
            const result = JSON.parse(action.result);
            const output = scrubSecretString(typeof result.output === 'string' ? result.output : 'Действие выполнено.').slice(0,8000);
            if (durable) recordNativeExecutionOutcome(db,approval.id,'completed',output);
            store.completeApproval(approval.id,identity.userId,true,output);
            link.execution = 'completed';
          } else if (durable?.execution !== nativeExecutionMarker) {
            // A missing marker or one from another boot has no live executor.
            // Side effects may have occurred; uncertainty is not definite failure.
            if (durable) recordNativeExecutionOutcome(db,approval.id,'interrupted',NATIVE_INTERRUPTED_MESSAGE);
            store.recordApprovalOutcome(approval.id,identity.userId,'interrupted',NATIVE_INTERRUPTED_MESSAGE);
            link.execution = 'interrupted';
          }
        }
      }
      return approval && String(approval.chat_id) === identity.userId ? [{...approval,execution:link.execution}] : [];
    });
    return json({approvals});
  }
  const conversationMatch = path.match(/^\/api\/native\/conversations\/([a-zA-Z0-9-]{16,64})$/);
  if (conversationMatch && req.method === 'GET') {
    const raw = new URL(req.url).searchParams.get('before'); const before = raw === null ? Number.MAX_SAFE_INTEGER : Number(raw);
    if (!Number.isSafeInteger(before) || before <= 0) return json({error:'invalid_cursor'},400);
    const history = store.history(conversationMatch[1],identity.userId,before);
    return history ? json(history) : json({error:'not_found'},404);
  }
  if (path === '/api/native/turns' && req.method === 'POST') {
    if (!lead || agentStopReason('orchestrator')) return json({ error: 'lead_unavailable' }, 503);
    let ids:string[]; let location;
    try { if(body.attachmentIds!==undefined && (!Array.isArray(body.attachmentIds) || body.attachmentIds.length>4 || body.attachmentIds.some(id=>typeof id!=='string'||!attachmentId.test(id)))) throw new Error(); ids=((body.attachmentIds??[]) as string[]).map(id=>id.toLowerCase()); if(new Set(ids).size!==ids.length) throw new Error(); location=locationValue(body.location); } catch { return json({error:'invalid_media'},400); }
    if (typeof body?.text !== 'string' || (!body.text.trim() && !ids.length && !location) || body.text.length > 8000 || typeof body.id !== 'string' || !/^[a-zA-Z0-9-]{16,64}$/.test(body.id)) return json({ error: 'invalid_turn' }, 400);
    const conversationId = body.conversationId;
    if (conversationId !== undefined && (typeof conversationId !== 'string' || !/^[a-zA-Z0-9-]{16,64}$/.test(conversationId) || !store.conversation(conversationId,identity.userId))) return json({error:'not_found'},404);
    let started;
    try { started = store.start(body.id, identity.device, identity.userId, body.text, conversationId as string|undefined,ids,location); } catch { return json({error:'media_conflict'},409); }
    if (started === 'busy' || started === 'conflict') return json({ error: started }, 409);
    if (started === 'created') {
      const id = body.id;
      const run = lead;
      // Detached job is persisted before invoking the lead; client polls, never replays on reconnect.
      const text = body.text;
      const deliver=(answer:string,agentKey='orchestrator')=>{
        const live=store.authenticate(token);
        if(process.env.NATIVE_APP_ENABLED!=='true'||!live||live.userId!==identity.userId||!permitted(identity.userId)||store.get(id,identity.device)?.status!=='running')throw new Error('native_turn_inactive');
        store.append(id,answer,agentKey);
      };
      void Promise.resolve().then(() => nativeTurnContext.run({userId:identity.userId,turnId:id,conversationId:store.turnConversation(id)!,knowledge:knowledgePrompt(store,identity.userId,store.turnConversation(id)!,text),readKnowledge:scopedKnowledgeReader(store,identity.userId,store.turnConversation(id)!),reply:async (agentKey,answer)=>{deliver(answer,agentKey);return {message_id:-Date.now(),date:Math.floor(Date.now()/1000)};},mediaSink:store.artifactSink(id,identity.userId,identity.device,store.turnConversation(id)!),linkApproval: approvalId => store.linkApproval(approvalId,id,identity.userId)}, () => run(identity.userId, text, answer => deliver(answer), typeof conversationId === 'string' ? store.history(conversationId,identity.userId)!.messages.slice(-40) : undefined,store.media.input(ids,identity.userId,location)))).then(() => {
        if (!store.get(id, identity.device)?.replies.length) store.append(id, 'Агент не вернул ответ. Проверь состояние роли и лимиты.');
        store.finish(id, 'done');
        const dialog=store.turnConversation(id);
        if(dialog) void compactNativeKnowledge(store,identity.userId,dialog,()=>process.env.NATIVE_APP_ENABLED==='true'&&!!store.authenticate(token)&&permitted(identity.userId));
      }).catch(() => {
        try {
          store.append(id, 'Запрос прерван. Проверь выполненные действия перед повтором.');
          store.finish(id, 'error');
        } catch { log.error('[native] failed to persist terminal job state'); }
      });
    }
    return json(store.get(body.id, identity.device), 202);
  }
  if (path.startsWith('/api/native/turns/') && req.method === 'GET') {
    const result = store.get(path.slice('/api/native/turns/'.length), identity.device);
    return result ? json(result) : json({ error: 'not_found' }, 404);
  }
  return json({ error: 'not_found' }, 404);
}

/** Browser boundary is separate; nativeApi still rejects every Origin. */
export async function webApi(req:Request,store?:NativeAccess, decide?:(req:Request)=>Promise<Response>):Promise<Response>{
 let origin:URL;try{origin=new URL(process.env.WEB_APP_ORIGIN??'');}catch{return json({error:'web_disabled'},503);}
 if(origin.protocol!=='https:'||origin.origin!==process.env.WEB_APP_ORIGIN)return json({error:'web_disabled'},503);
 const url=new URL(req.url),supplied=req.headers.get('origin');
 if(!url.pathname.startsWith('/api/web/')||req.headers.has('cookie')||req.headers.get('sec-fetch-site')!=='same-origin'||(supplied!==null&&supplied!==origin.origin)||(req.method!=='GET'&&supplied!==origin.origin)||!['GET','POST'].includes(req.method))return json({error:'web_origin_forbidden'},403);
 const headers=new Headers();for(const name of ['authorization','content-type','content-length']){const value=req.headers.get(name);if(value!==null)headers.set(name,value);}
 const approval=req.method==='POST'&&/^\/api\/web\/approvals\/[a-zA-Z0-9-]{1,128}\/decide$/.test(url.pathname);
 const target=new URL(origin.origin);target.pathname=url.pathname.replace('/api/web/',approval?'/api/':'/api/native/');target.search=url.search;
 const trusted=new Request(target,{method:req.method,headers,body:req.body,signal:req.signal,duplex:'half'} as RequestInit);
 return approval?(decide?decide(trusted):json({error:'not_found'},404)):nativeApi(trusted,store);
}
