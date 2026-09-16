/** Separate device credentials/job state; never stores Telegram or service credentials. */
import { NativeMedia, parseUpload, type NativeLocation } from './native-media.ts';
import { DAY_MS } from './time-constants.ts';
import { Database } from 'bun:sqlite';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { NativeArtifactSink, NativeGeneration, NativeExecutionOutcome } from './native-context.ts';
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
export class NativeAccess {
  readonly db: Database;
  readonly media: NativeMedia;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true, mode: 0o700 });
    this.db = new Database(path);
    this.media = new NativeMedia(this.db,path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.run(`CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,title TEXT NOT NULL,created INTEGER NOT NULL,updated INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS conversation_turns(turn_id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS conversation_approvals(approval_id TEXT PRIMARY KEY,turn_id TEXT NOT NULL,execution TEXT);
      CREATE TABLE IF NOT EXISTS conversation_messages(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,conversation_id TEXT NOT NULL,role TEXT NOT NULL,text TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS conversation_owner ON conversations(user_id,updated);
      CREATE INDEX IF NOT EXISTS conversation_history ON conversation_messages(conversation_id,seq);
      CREATE TABLE IF NOT EXISTS codes(hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS devices(hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS turns(id TEXT PRIMARY KEY, device TEXT NOT NULL, user_id TEXT NOT NULL,
        text TEXT NOT NULL, status TEXT NOT NULL, replies TEXT NOT NULL DEFAULT '[]', created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS native_output_media(message_id TEXT PRIMARY KEY,turn_id TEXT NOT NULL,media TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS native_generations(id TEXT PRIMARY KEY,turn_id TEXT NOT NULL,state TEXT NOT NULL,started INTEGER NOT NULL,ended INTEGER);
      CREATE TABLE IF NOT EXISTS alert_settings(user_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS alert_state(user_id TEXT NOT NULL, agent TEXT NOT NULL, unhealthy INTEGER NOT NULL, PRIMARY KEY(user_id,agent));`);
    // Archive retained legacy messages before short-lived polling rows expire.
    this.db.transaction(() => {
      const rows = this.db.query('SELECT * FROM turns WHERE id NOT IN (SELECT turn_id FROM conversation_turns) ORDER BY created,id').all() as {id:string;user_id:string;text:string;replies:string;created:number}[];
      for (const row of rows) {
        const owned = this.db.query("SELECT id FROM conversations WHERE user_id=? AND id LIKE 'legacy-%' ORDER BY created LIMIT 1").get(row.user_id) as {id:string}|null;
        const dialog = owned?.id ?? 'legacy-' + randomBytes(16).toString('hex');
        this.db.query('INSERT OR IGNORE INTO conversations VALUES(?,?,?,?,?)').run(dialog,row.user_id,'Ранее в приложении',row.created,row.created);
        this.db.query('INSERT INTO conversation_turns VALUES(?,?)').run(row.id,dialog);
        const insert = this.db.query('INSERT INTO conversation_messages(id,conversation_id,role,text) VALUES(?,?,?,?)');
        insert.run(row.id+':user',dialog,'user',row.text);
        (JSON.parse(row.replies) as string[]).forEach((text,index) => insert.run(row.id+':reply:'+(index+1),dialog,'assistant',text));
        this.db.query('UPDATE conversations SET updated=MAX(updated,?) WHERE id=?').run(row.created,dialog);
      }
    })();
    // Never replay side effects after a process restart.
    this.db.run("UPDATE turns SET status='interrupted' WHERE status='running'");
    this.db.query("UPDATE native_generations SET state='interrupted',ended=? WHERE state='running'").run(Date.now());
    this.prune();
  }
  prune(now = Date.now()) {
    this.media.prune(now);
    this.db.query('DELETE FROM codes WHERE expires < ?').run(now);
    this.db.query('DELETE FROM devices WHERE expires < ?').run(now);
    this.db.query("DELETE FROM turns WHERE created < ? AND status != 'running'").run(now - 7 * DAY_MS);
  }
  alerts(userId: string, enabled: boolean) {
    this.db.query('INSERT INTO alert_settings VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET enabled=excluded.enabled').run(userId, enabled ? 1 : 0);
  }
  alertUsers(): string[] {
    return (this.db.query('SELECT user_id FROM alert_settings WHERE enabled=1').all() as {user_id: string}[]).map(r => r.user_id);
  }
  alertChanged(userId: string, agent: string, unhealthy: boolean): boolean {
    const before = this.db.query('SELECT unhealthy FROM alert_state WHERE user_id=? AND agent=?').get(userId, agent) as {unhealthy:number} | null;
    return before ? before.unhealthy !== Number(unhealthy) : unhealthy;
  }
  markAlert(userId: string, agent: string, unhealthy: boolean) {
    this.db.query('INSERT INTO alert_state VALUES(?,?,?) ON CONFLICT(user_id,agent) DO UPDATE SET unhealthy=excluded.unhealthy').run(userId, agent, unhealthy ? 1 : 0);
  }
  pair(userId: string): string {
    this.prune();
    const code = randomBytes(16).toString('hex');
    this.db.query('DELETE FROM codes WHERE user_id=?').run(userId);
    this.db.query('INSERT INTO codes VALUES(?,?,?)').run(hash(code), userId, Date.now() + 300_000);
    return code;
  }
  redeem(code: string): { token: string; userId: string } | null {
    return this.db.transaction(() => {
      const row = this.db.query('SELECT user_id FROM codes WHERE hash=? AND expires>=?').get(hash(code), Date.now()) as { user_id: string } | null;
      if (!row) return null;
      this.db.query('DELETE FROM codes WHERE hash=?').run(hash(code));
      const token = randomBytes(32).toString('hex');
      this.db.query('INSERT INTO devices VALUES(?,?,?)').run(hash(token), row.user_id, Date.now() + 30 * DAY_MS);
      return { token, userId: row.user_id };
    })();
  }
  authenticate(token: string): { device: string; userId: string } | null {
    if (!/^[a-f0-9]{64}$/.test(token)) return null;
    const device = hash(token);
    const row = this.db.query('SELECT user_id FROM devices WHERE hash=? AND expires>=?').get(device, Date.now()) as { user_id: string } | null;
    return row ? { device, userId: row.user_id } : null;
  }
  revoke(userId: string) {
    this.db.query('DELETE FROM devices WHERE user_id=?').run(userId);
    this.db.query('DELETE FROM codes WHERE user_id=?').run(userId);
  }
  get(id: string, device: string) {
    const row = this.db.query('SELECT id,status,replies FROM turns WHERE id=? AND device=?').get(id, device) as { id: string; status: string; replies: string } | null;
    const outputMedia=this.outputMedia(id),generations=this.generations(id);
    return row ? { ...row, replies: JSON.parse(row.replies) as string[], ...(outputMedia.length?{outputMedia}:{}), ...(generations.length?{generations}:{}) } : null;
  }
  start(id: string, device: string, userId: string, text: string, conversationId?: string, attachmentIds: string[] = [], location?: NativeLocation): 'created' | 'duplicate' | 'busy' | 'conflict' {
    this.prune();
    return this.db.transaction(() => {
      const existing = this.db.query('SELECT device,text FROM turns WHERE id=?').get(id) as { device: string; text: string } | null;
      if (existing) {
        const linked = this.db.query('SELECT conversation_id FROM conversation_turns WHERE turn_id=?').get(id) as {conversation_id:string}|null;
        return this.media.signature(id) === JSON.stringify({attachmentIds,...(location?{location}:{})}) && existing.device === device && existing.text === text && (!conversationId || linked?.conversation_id === conversationId) ? 'duplicate' : 'conflict';
      }
      if (this.db.query('SELECT 1 FROM conversation_turns WHERE turn_id=?').get(id)) return 'conflict';
      if (conversationId && !this.conversation(conversationId,userId)) return 'conflict';
      if (this.db.query("SELECT 1 FROM turns WHERE user_id=? AND status='running'").get(userId)) return 'busy';
      this.media.bind(id,userId,attachmentIds,location);
      if (!conversationId) {
        const owned = this.db.query("SELECT id FROM conversations WHERE user_id=? AND id LIKE 'legacy-%' ORDER BY created LIMIT 1").get(userId) as {id:string}|null;
        conversationId = owned?.id ?? 'legacy-' + randomBytes(16).toString('hex');
        this.db.query('INSERT OR IGNORE INTO conversations VALUES(?,?,?,?,?)').run(conversationId,userId,'Ранее в приложении',Date.now(),Date.now());
      }
      this.db.query("INSERT INTO turns(id,device,user_id,text,status,created) VALUES(?,?,?,?,'running',?)").run(id, device, userId, text, Date.now());
      if (conversationId) {
        this.db.query('INSERT INTO conversation_turns VALUES(?,?)').run(id,conversationId);
        this.db.query('INSERT INTO conversation_messages(id,conversation_id,role,text) VALUES(?,?,?,?)').run(id+':user',conversationId,'user',text);
        this.db.query('UPDATE conversations SET updated=? WHERE id=?').run(Date.now(),conversationId);
      }
      return 'created';
    })();
  }
  append(id: string, text: string) {
    this.db.transaction(() => {
    const row = this.db.query("SELECT replies FROM turns WHERE id=? AND status='running'").get(id) as { replies: string } | null;
    if(!row) return;
    const replies = JSON.parse(row.replies) as string[];
    if (replies.length >= 80) return;
    replies.push(text.slice(0, 8000));
    const link = this.db.query('SELECT conversation_id FROM conversation_turns WHERE turn_id=?').get(id) as {conversation_id:string}|null;
    if (link) {
      this.db.query('INSERT OR IGNORE INTO conversation_messages(id,conversation_id,role,text) VALUES(?,?,?,?)').run(id+':reply:'+replies.length,link.conversation_id,'assistant',text.slice(0,8000));
      this.db.query('UPDATE conversations SET updated=? WHERE id=?').run(Date.now(),link.conversation_id);
    }
    this.db.query('UPDATE turns SET replies=? WHERE id=?').run(JSON.stringify(replies), id);
    })();
  }
  turnConversation(turnId:string): string | undefined {
    return (this.db.query('SELECT conversation_id FROM conversation_turns WHERE turn_id=?').get(turnId) as {conversation_id:string}|null)?.conversation_id;
  }
  linkApproval(approvalId: string, turnId: string, userId: string) {
    const link = this.db.query('SELECT 1 FROM conversation_turns t JOIN conversations c ON c.id=t.conversation_id WHERE t.turn_id=? AND c.user_id=?').get(turnId,userId);
    if (link) this.db.query('INSERT OR IGNORE INTO conversation_approvals(approval_id,turn_id) VALUES(?,?)').run(approvalId,turnId);
  }
  conversationApprovals(id: string, userId: string) {
    if (!this.conversation(id,userId)) return null;
    return this.db.query('SELECT a.approval_id,a.execution FROM conversation_approvals a JOIN conversation_turns t ON t.turn_id=a.turn_id WHERE t.conversation_id=?').all(id) as {approval_id:string;execution:string|null}[];
  }
  completeApproval(approvalId: string, userId: string, ok: boolean, text: string) {
    this.recordApprovalOutcome(approvalId,userId,ok ? 'completed' : 'failed',text);
  }
  recordApprovalOutcome(approvalId:string,userId:string,outcome:NativeExecutionOutcome,text:string) {
    this.db.transaction(() => {
      const link = this.db.query('SELECT t.conversation_id FROM conversation_approvals a JOIN conversation_turns t ON t.turn_id=a.turn_id JOIN conversations c ON c.id=t.conversation_id WHERE a.approval_id=? AND c.user_id=? AND a.execution IS NULL').get(approvalId,userId) as {conversation_id:string}|null;
      if (!link) return;
      this.db.query('INSERT OR IGNORE INTO conversation_messages(id,conversation_id,role,text) VALUES(?,?,?,?)').run('approval:'+approvalId+':result',link.conversation_id,'assistant',text.slice(0,8000));
      this.db.query('UPDATE conversation_approvals SET execution=? WHERE approval_id=?').run(outcome,approvalId);
      this.db.query('UPDATE conversations SET updated=? WHERE id=?').run(Date.now(),link.conversation_id);
    })();
  }
  conversation(id: string, userId: string) {
    return this.db.query('SELECT id,title,created,updated FROM conversations WHERE id=? AND user_id=?').get(id,userId);
  }
  createConversation(id:string,userId:string,title:string) {
    this.db.query('INSERT OR IGNORE INTO conversations VALUES(?,?,?,?,?)').run(id,userId,title.slice(0,100),Date.now(),Date.now());
    return this.conversation(id,userId);
  }
  running(userId:string) { return !!this.db.query("SELECT 1 FROM turns WHERE user_id=? AND status='running'").get(userId); }
  conversations(userId:string, before?: {updated:number;id:string}, limit = 200) {
    const fields = 'SELECT id,title,created,updated FROM conversations WHERE user_id=?';
    const order = ' ORDER BY updated DESC,id DESC LIMIT ?';
    return (before
      ? this.db.query(fields + ' AND (updated < ? OR (updated = ? AND id < ?))' + order).all(userId,before.updated,before.updated,before.id,limit)
      : this.db.query(fields + order).all(userId,limit)) as {id:string;title:string;created:number;updated:number}[];
  }
  history(id:string,userId:string,before = Number.MAX_SAFE_INTEGER) {
    if (!this.conversation(id,userId)) return null;
    const rows = this.db.query('SELECT seq,id,role,text FROM conversation_messages WHERE conversation_id=? AND seq<? ORDER BY seq DESC LIMIT 101').all(id,before) as {seq:number;id:string;role:string;text:string}[];
    const more = rows.length > 100; const messages = rows.slice(0,100).reverse().map(row => ({...row,...(row.role === 'user' ? this.media.history(row.id.replace(/:user$/,''),userId) : this.outputAttachments(row.id))}));
    const running = this.running(userId);
    const generations=(this.db.query('SELECT g.id,g.state,g.started,g.ended FROM native_generations g JOIN conversation_turns t ON t.turn_id=g.turn_id WHERE t.conversation_id=? ORDER BY g.started DESC LIMIT 100').all(id) as NativeGeneration[]).map(g=>({...g,ended:g.ended ?? undefined}));
    return {messages,more,running,generations};
  }
  private outputAttachments(messageId:string):{attachments?:import('./native-media.ts').Attachment[];location?:NativeLocation} {
    const row=this.db.query('SELECT media FROM native_output_media WHERE message_id=?').get(messageId) as {media:string}|null;
    return row ? {attachments:JSON.parse(row.media) as import('./native-media.ts').Attachment[]} : {};
  }
  private outputMedia(turnId:string) {
    return (this.db.query('SELECT message_id,media FROM native_output_media WHERE turn_id=? ORDER BY rowid').all(turnId) as {message_id:string;media:string}[]).map(r=>({messageId:r.message_id,attachments:JSON.parse(r.media) as import('./native-media.ts').Attachment[]}));
  }
  private generations(turnId:string) {
    return (this.db.query('SELECT id,state,started,ended FROM native_generations WHERE turn_id=? ORDER BY started,rowid').all(turnId) as NativeGeneration[]).map(g=>({...g,ended:g.ended ?? undefined}));
  }
  artifactSink(turnId:string,userId:string,device:string,conversationId:string):NativeArtifactSink {
    const assertActive=()=> {
      if(!this.db.query("SELECT 1 FROM turns t JOIN conversation_turns ct ON ct.turn_id=t.id JOIN conversations c ON c.id=ct.conversation_id JOIN devices d ON d.hash=t.device WHERE t.id=? AND t.user_id=? AND t.device=? AND c.user_id=? AND c.id=? AND t.status='running' AND d.user_id=? AND d.expires>=?").get(turnId,userId,device,userId,conversationId,userId,Date.now())) throw new Error('native_turn_inactive');
    };
    return {
      assertActive,
      deliver:media=>this.db.transaction(()=> {
        assertActive();
        const replies=JSON.parse((this.db.query('SELECT replies FROM turns WHERE id=?').get(turnId) as {replies:string}).replies) as string[];
        if(replies.length>=80) throw new Error('native_output_limit');
        const item=this.media.put(userId,parseUpload({id:randomUUID(),name:media.name,mimeType:media.mimeType,data:media.data.toString('base64')}));
        this.db.query('UPDATE native_attachments SET turn_id=?,linked=? WHERE id=? AND user_id=?').run(turnId,Date.now(),item.id,userId);
        this.append(turnId,media.caption ?? '');
        const messageId=turnId+':reply:'+(replies.length+1);
        this.db.query('INSERT INTO native_output_media VALUES(?,?,?)').run(messageId,turnId,JSON.stringify([item]));
        return {ok:true as const,messageId:replies.length+1,nativeMessageId:messageId};
      })(),
      startGeneration:()=>this.db.transaction(()=> {
        assertActive();
        if(this.generations(turnId).length>=40) throw new Error('native_generation_limit');
        const id=randomUUID();this.db.query("INSERT INTO native_generations VALUES(?,?,'running',?,NULL)").run(id,turnId,Date.now());return id;
      })(),
      endGeneration:(id,state)=> {this.db.query("UPDATE native_generations SET state=?,ended=? WHERE id=? AND turn_id=? AND state='running'").run(state,Date.now(),id,turnId);},
    };
  }
  finish(id: string, status: 'done' | 'error') {
    this.db.transaction(()=> {
      this.db.query("UPDATE native_generations SET state='interrupted',ended=? WHERE turn_id=? AND state='running'").run(Date.now(),id);
      this.db.query("UPDATE turns SET status=? WHERE id=? AND status='running'").run(status,id);
    })();
  }
}
let store: NativeAccess | undefined;
export function nativeAccess(): NativeAccess {
  return store ??= new NativeAccess(process.env.NATIVE_STATE_PATH || resolve(dirname(process.env.MEMORY_DB_PATH || 'data/memory.db'), 'native.db'));
}
