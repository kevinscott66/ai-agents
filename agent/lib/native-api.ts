import { nativeAccess, type NativeAccess } from './native-access.ts';
import { isAssistantOwner as permitted } from './assistant-auth.ts';
import { agentStopReason } from './permissions.ts';
import { readNativeJson } from './native-request.ts';
import { log } from './log.ts';

export type NativeLead = (userId: string, text: string, reply: (text: string) => void, history?: {role:string;text:string}[]) => Promise<void>;
let lead: NativeLead | undefined;
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
  let body: Record<string, unknown> = {};
  if (req.method === 'POST') {
    try { body = await readNativeJson(req); }
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
  if (!identity || !permitted(identity.userId)) return json({ error: 'unauthorized' }, 401);
  if (path === '/api/native/status' && req.method === 'GET') return json({ name: 'Агент', userId: identity.userId, available: !!lead && !agentStopReason('orchestrator') });
  if (path === '/api/native/conversations' && req.method === 'GET') return json({conversations:store.conversations(identity.userId),running:store.running(identity.userId)});
  if (path === '/api/native/conversations' && req.method === 'POST') {
    if (typeof body.id !== 'string' || (body.id.startsWith('legacy-') && !store.conversation(body.id,identity.userId)) || !/^[a-zA-Z0-9-]{16,64}$/.test(body.id) || typeof body.title !== 'string' || !body.title.trim() || body.title.length > 100) return json({error:'invalid_conversation'},400);
    const conversation = store.createConversation(body.id,identity.userId,body.title);
    return conversation ? json({conversation}) : json({error:'not_found'},404);
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
    if (typeof body?.text !== 'string' || !body.text.trim() || body.text.length > 8000 || typeof body.id !== 'string' || !/^[a-zA-Z0-9-]{16,64}$/.test(body.id)) return json({ error: 'invalid_turn' }, 400);
    const conversationId = body.conversationId;
    if (conversationId !== undefined && (typeof conversationId !== 'string' || !/^[a-zA-Z0-9-]{16,64}$/.test(conversationId) || !store.conversation(conversationId,identity.userId))) return json({error:'not_found'},404);
    const started = store.start(body.id, identity.device, identity.userId, body.text, conversationId as string|undefined);
    if (started === 'busy' || started === 'conflict') return json({ error: started }, 409);
    if (started === 'created') {
      const id = body.id;
      const run = lead;
      // Detached job is persisted before invoking the lead; client polls, never replays on reconnect.
      const text = body.text;
      void Promise.resolve().then(() => run(identity.userId, text, answer => store.append(id, answer), typeof conversationId === 'string' ? store.history(conversationId,identity.userId)!.messages.slice(-40) : undefined)).then(() => {
        if (!store.get(id, identity.device)?.replies.length) store.append(id, 'Агент не вернул ответ. Проверь состояние роли и лимиты.');
        store.finish(id, 'done');
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
