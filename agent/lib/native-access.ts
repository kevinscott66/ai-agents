/** Separate device credentials/job state; never stores Telegram or service credentials. */
import { DAY_MS } from './time-constants.ts';
import { Database } from 'bun:sqlite';
import { randomBytes, createHash } from 'node:crypto';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
export class NativeAccess {
  readonly db: Database;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true, mode: 0o700 });
    this.db = new Database(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.run(`CREATE TABLE IF NOT EXISTS codes(hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS devices(hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS turns(id TEXT PRIMARY KEY, device TEXT NOT NULL, user_id TEXT NOT NULL,
        text TEXT NOT NULL, status TEXT NOT NULL, replies TEXT NOT NULL DEFAULT '[]', created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS alert_settings(user_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS alert_state(user_id TEXT NOT NULL, agent TEXT NOT NULL, unhealthy INTEGER NOT NULL, PRIMARY KEY(user_id,agent));`);
    // Never replay side effects after a process restart.
    this.db.run("UPDATE turns SET status='interrupted' WHERE status='running'");
    this.prune();
  }
  prune(now = Date.now()) {
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
    return row ? { ...row, replies: JSON.parse(row.replies) as string[] } : null;
  }
  start(id: string, device: string, userId: string, text: string): 'created' | 'duplicate' | 'busy' | 'conflict' {
    this.prune();
    return this.db.transaction(() => {
      const existing = this.db.query('SELECT device,text FROM turns WHERE id=?').get(id) as { device: string; text: string } | null;
      if (existing) return existing.device === device && existing.text === text ? 'duplicate' : 'conflict';
      if (this.db.query("SELECT 1 FROM turns WHERE user_id=? AND status='running'").get(userId)) return 'busy';
      this.db.query("INSERT INTO turns(id,device,user_id,text,status,created) VALUES(?,?,?,?,'running',?)").run(id, device, userId, text, Date.now());
      return 'created';
    })();
  }
  append(id: string, text: string) {
    const row = this.db.query('SELECT replies FROM turns WHERE id=?').get(id) as { replies: string };
    const replies = JSON.parse(row.replies) as string[];
    if (replies.length < 80) replies.push(text.slice(0, 8000));
    this.db.query('UPDATE turns SET replies=? WHERE id=?').run(JSON.stringify(replies), id);
  }
  finish(id: string, status: 'done' | 'error') { this.db.query('UPDATE turns SET status=? WHERE id=?').run(status, id); }
}
let store: NativeAccess | undefined;
export function nativeAccess(): NativeAccess {
  return store ??= new NativeAccess(process.env.NATIVE_STATE_PATH || resolve(dirname(process.env.MEMORY_DB_PATH || 'data/memory.db'), 'native.db'));
}
