import { randomUUID } from 'node:crypto';
import { readNativeJson } from './native-request.ts';

export type RemoteIdentity = { userId: string; device: string };
type Live = () => boolean;
type Input = { kind: string; frameID: number; x?: number; y?: number; endX?: number; endY?: number; delta?: number; keycode?: number; modifiers?: number; text?: string };
type Command = Input & { id: string; at: number };
type Host = { id: string; epoch: string; owner: string; device: string; name: string; control: boolean; seen: number; live: Live; session?: string };
type Session = { id: string; host: string; owner: string; viewer: string; live: Live; status: 'pending' | 'active'; created: number; activity: number; frame: string | null; frameID: number; frameAt: number; frames: Map<number, number>; delivered: Set<number>; commands: Command[] };
const HEARTBEAT = 15_000, IDLE = 30_000, MAX_SESSION = 15 * 60_000;
const FRAME_BYTES = 1_000_000, GLOBAL_FRAME_CHARS = 16_000_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
class Failure extends Error { constructor(readonly status: number, message: string) { super(message); } }
const fail = (status: number, text: string): never => { throw new Failure(status, text); };
const alive = (check: Live) => { try { return check(); } catch { return false; } };
const number = (v: unknown, min: number, max: number) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
function input(body: Record<string, unknown>): Input {
  const kind = body.kind;
  if (!Number.isSafeInteger(body.frameID) || (body.frameID as number) < 1) fail(400, 'invalid_frame');
  const value: Input = { kind: String(kind), frameID: body.frameID as number };
  if (kind === 'click' || kind === 'doubleClick' || kind === 'rightClick' || kind === 'drag') {
    if (!number(body.x, 0, 1) || !number(body.y, 0, 1)) fail(400, 'invalid_point');
    value.x = body.x as number; value.y = body.y as number;
    if (kind === 'drag') {
      if (!number(body.endX, 0, 1) || !number(body.endY, 0, 1)) fail(400, 'invalid_point');
      value.endX = body.endX as number; value.endY = body.endY as number;
    }
  } else if (kind === 'scroll') {
    if (!number(body.x, 0, 1) || !number(body.y, 0, 1)) fail(400, 'invalid_point');
    value.x = body.x as number; value.y = body.y as number;
    if (!number(body.delta, -1000, 1000)) fail(400, 'invalid_delta');
    value.delta = body.delta as number;
  } else if (kind === 'key') {
    if (!Number.isInteger(body.keycode) || !number(body.keycode, 0, 126) || !Number.isSafeInteger(body.modifiers) || !number(body.modifiers, 0, 0x1e0000) || ((body.modifiers as number) & ~0x1e0000) !== 0) fail(400, 'invalid_key');
    value.keycode = body.keycode as number; value.modifiers = body.modifiers as number;
  } else if (kind === 'text') {
    if (typeof body.text !== 'string' || !body.text.length || body.text.length > 1000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(body.text)) fail(400, 'invalid_text');
    value.text = body.text as string;
  } else fail(400, 'invalid_kind');
  if (['click', 'doubleClick', 'rightClick', 'drag', 'scroll'].includes(String(kind))) {
    const modifiers = body.modifiers ?? 0;
    if (!Number.isSafeInteger(modifiers) || !number(modifiers, 0, 0x1e0000) || ((modifiers as number) & ~0x1e0000) !== 0) fail(400, 'invalid_modifiers');
    value.modifiers = modifiers as number;
  }
  return value;
}

/** Ephemeral relay only: owner/device identifiers are supplied by native authentication. */
export class RemoteRelay {
  private hosts = new Map<string, Host>();
  private sessions = new Map<string, Session>();
  private rates = new Map<string, { start: number; count: number }>();
  private now: () => number;
  private uploads = 0;
  constructor(options: { now?: () => number } = {}) { this.now = options.now ?? Date.now; }
  private removeSession(id: string) {
    const session = this.sessions.get(id);
    if (session) { const host = this.hosts.get(session.host); if (host?.session === id) delete host.session; }
    this.sessions.delete(id);
  }
  prune() {
    const now = this.now();
    for (const [id, host] of this.hosts) if (now - host.seen >= HEARTBEAT || !alive(host.live)) {
      if (host.session) this.removeSession(host.session);
      this.hosts.delete(id);
    }
    for (const [id, session] of this.sessions) if (!this.hosts.has(session.host) || now - session.activity >= IDLE || now - session.created >= MAX_SESSION || !alive(session.live)) this.removeSession(id);
    for (const [key, rate] of this.rates) if (now - rate.start >= 60_000) this.rates.delete(key);
  }
  private rate(key: string, limit: number, window = 1000) {
    const now = this.now(); let rate = this.rates.get(key);
    if (!rate || now - rate.start >= window) { if (!rate && this.rates.size >= 4096) fail(429, 'relay_busy'); rate = { start: now, count: 0 }; this.rates.set(key, rate); }
    if (++rate.count > limit) fail(429, 'rate_limited');
  }
  private host(identity: RemoteIdentity): Host {
    const host = [...this.hosts.values()].find(h => h.device === identity.device && h.owner === identity.userId);
    return host ?? fail(404, 'host_not_found');
  }
  private session(id: string, identity: RemoteIdentity, hostAllowed = false): Session {
    const session = this.sessions.get(id), host = session && this.hosts.get(session.host);
    if (!session || session.owner !== identity.userId || (session.viewer !== identity.device && !(hostAllowed && host?.device === identity.device))) fail(404, 'session_not_found');
    return session!;
  }
  async handle(req: Request, identity: RemoteIdentity, live: Live): Promise<Response> {
    try {
      if (!alive(live)) fail(401, 'unauthorized');
      const url = new URL(req.url);
      if (req.headers.has('origin') || url.search) fail(403, 'native_only');
      if (!['GET', 'POST'].includes(req.method)) fail(405, 'method_not_allowed');
      this.prune();
      const path = url.pathname.replace(/^\/api\/native\/remote(?=\/|$)/, '');
      if (path === url.pathname) fail(404, 'not_found');
      this.rate('all:' + identity.device, 50);
      let body: Record<string, unknown> = {};
      if (req.method === 'POST') {
        const frameUpload = path === '/host/frame';
        if (frameUpload) {
          this.rate('frame:' + identity.device, 8);
          if (this.uploads >= 4) fail(429, 'upload_busy');
          this.uploads++;
        }
        try { body = await readNativeJson(req, 5000, frameUpload ? 1_400_000 : 16_384); }
        finally { if (frameUpload) this.uploads--; }
        if (!alive(live)) fail(401, 'unauthorized');
        this.prune();
      }
      const now = this.now();
      if (path === '/host' && req.method === 'POST') {
        this.rate('register:' + identity.device, 6, 60_000);
        if (body.control !== undefined && typeof body.control !== 'boolean') fail(400, 'invalid_control');
        if (body.name !== undefined && (typeof body.name !== 'string' || body.name.length > 100)) fail(400, 'invalid_name');
        const existing = [...this.hosts.values()].find(h => h.device === identity.device && h.owner === identity.userId);
        if (existing?.session) this.removeSession(existing.session);
        if (!existing && (this.hosts.size >= 32 || [...this.hosts.values()].filter(h => h.owner === identity.userId).length >= 4)) fail(429, 'host_limit');
        const host: Host = { id: existing?.id ?? randomUUID(), epoch: randomUUID(), owner: identity.userId, device: identity.device, name: (body.name as string | undefined)?.trim() || 'Mac', control: body.control === true, seen: now, live };
        this.hosts.set(host.id, host);
        return json({ host: host.id, epoch: host.epoch, expiresAt: now + HEARTBEAT });
      }
      if (path === '/hosts' && req.method === 'GET') return json({ hosts: [...this.hosts.values()].filter(h => h.owner === identity.userId).map(h => ({ id: h.id, name: h.name, control: h.control, epoch: h.epoch, expiresAt: h.seen + HEARTBEAT })) });
      if (path === '/request' && req.method === 'POST') {
        this.rate('request:' + identity.device, 6, 60_000);
        const host = typeof body.host === 'string' ? this.hosts.get(body.host) : undefined;
        if (!host || host.owner !== identity.userId || host.device === identity.device) fail(404, 'host_not_found');
        if (host!.session) fail(409, 'host_busy');
        const session: Session = { id: randomUUID(), host: host!.id, owner: identity.userId, viewer: identity.device, live, status: 'pending', created: now, activity: now, frame: null, frameID: 0, frameAt: 0, frames: new Map(), delivered: new Set(), commands: [] };
        this.sessions.set(session.id, session); host!.session = session.id;
        return json({ session: session.id, status: session.status });
      }
      if (path.startsWith('/host/')) {
        const host = this.host(identity);
        if (path === '/host/stop' && req.method === 'POST') { if (body.epoch !== host.epoch) fail(409, 'stale_epoch'); if (host.session) this.removeSession(host.session); this.hosts.delete(host.id); return json({ ok: true }); }
        if (path === '/host/poll' && req.method === 'GET') {
          host.seen = now;
          const session = host.session ? this.sessions.get(host.session) : undefined;
          // Commands are transient: a delayed host must never execute old input.
          const commands = session?.commands.filter(c => now - c.at < 3000) ?? [];
          if (session) session.commands = [];
          return json({ host: host.id, epoch: host.epoch, session: session ? { id: session.id, status: session.status, viewer: session.viewer, expiresAt: Math.min(session.activity + IDLE, session.created + MAX_SESSION) } : null, commands });
        }
        const session = host.session ? this.sessions.get(host.session) : undefined;
        if (!session || session.id !== body.session) fail(404, 'session_not_found');
        if (path === '/host/accept' && req.method === 'POST') {
          if (session!.status !== 'pending') fail(409, 'already_active');
          session!.status = 'active'; session!.activity = now; host.seen = now;
          return json({ ok: true });
        }
        if (path === '/host/frame' && req.method === 'POST') {
          if (session!.status !== 'active') fail(409, 'not_active');
          const frame = body.frame;
          if (typeof frame !== 'string' || frame.length > Math.ceil(FRAME_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(frame) || frame.length % 4 !== 0) fail(400, 'invalid_frame');
          const bytes = Buffer.from(frame as string, 'base64');
          if (bytes.length > FRAME_BYTES || bytes.length < 4 || bytes[0] !== 255 || bytes[1] !== 216 || bytes.at(-2) !== 255 || bytes.at(-1) !== 217) fail(400, 'invalid_jpeg');
          const retained = [...this.sessions.values()].reduce((total, s) => total + (s.frame?.length ?? 0), 0) - (session!.frame?.length ?? 0);
          if (retained + (frame as string).length > GLOBAL_FRAME_CHARS) fail(429, 'frame_memory_limit');
          session!.frame = frame as string; session!.frameID++; session!.frameAt = now; session!.frames.set(session!.frameID, now);
          for (const [id, at] of session!.frames) if (now - at >= 3000) { session!.frames.delete(id); session!.delivered.delete(id); }
          host.seen = now;
          return json({ frameID: session!.frameID });
        }
        fail(404, 'not_found');
      }
      const match = /^\/session\/([^/]+)(?:\/(input|stop))?$/.exec(path);
      if (!match || !UUID.test(match[1])) fail(404, 'not_found');
      const session = this.session(match![1], identity, match![2] === 'stop');
      if (match![2] === 'stop' && req.method === 'POST') { this.removeSession(session.id); return json({ ok: true }); }
      if (!match![2] && req.method === 'GET') {
        session.activity = now;
        if (session.frame) session.delivered.add(session.frameID);
        return json({ session: session.id, status: session.status, control: this.hosts.get(session.host)!.control, frame: session.frame, frameID: session.frameID, frameAt: session.frameAt, expiresAt: Math.min(now + IDLE, session.created + MAX_SESSION) });
      }
      if (match![2] === 'input' && req.method === 'POST') {
        if (session.status !== 'active') fail(409, 'not_active');
        if (!this.hosts.get(session.host)!.control) fail(403, 'view_only');
        const command = input(body);
        if (!session.delivered.has(command.frameID) || !session.frames.has(command.frameID) || now - session.frames.get(command.frameID)! >= 3000) fail(409, 'stale_frame');
        this.rate('input:' + session.id, 20);
        if (session.commands.length >= 64) fail(429, 'queue_full');
        const id = randomUUID(); session.commands.push({ ...command, id, at: now }); session.activity = now;
        return json({ ok: true, id });
      }
      return fail(404, 'not_found');
    } catch (error) {
      if (error instanceof Failure) return json({ error: error.message }, error.status);
      const message = error instanceof Error ? error.message : '';
      return json({ error: ['json_required', 'body_too_large', 'body_timeout', 'body_aborted'].includes(message) ? message : 'invalid_request' }, message === 'body_too_large' ? 413 : message === 'body_timeout' ? 408 : 400);
    }
  }
}
export const remoteRelay = new RemoteRelay();
const cleanup = setInterval(() => remoteRelay.prune(), 5000);
cleanup.unref();
export function remoteApi(req: Request, identity: RemoteIdentity, live: Live) { return remoteRelay.handle(req, identity, live); }
