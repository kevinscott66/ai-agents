import type { Database } from 'bun:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { scrubSecretString } from './log.ts';
export type KnowledgeEntry = {
    id: string;
    kind: 'fact' | 'decision' | 'task';
    text: string;
    sourceMessageIds: string[];
};
export type KnowledgeProject = {
    id: string;
    title: string;
    created: number;
    updated: number;
};
export type KnowledgeProposal = {
    id: string;
    projectId: string;
    conversationId: string;
    revision: number;
    entry: KnowledgeEntry;
};
function fingerprint(entry: KnowledgeEntry): string {
    return createHash('sha256').update(JSON.stringify([entry.kind, entry.text])).digest('hex');
}
const invalid = () => new Error('invalid_knowledge');
function clean(value: unknown, max: number): string { if (typeof value !== 'string' || !value.trim() || value.length > max)
    throw invalid(); return scrubSecretString(value.trim()).replace(/((?:api[_-]?key|token|secret|password|passwd)\s*[=:]\s*)[^\s,;]+/gi, '$1[redacted]'); }
/** Strict full replacement; provenance is checked against the scoped message archive on write. */
export function parseKnowledgeUpdate(raw: unknown): KnowledgeEntry[] {
    if (typeof raw === 'string') {
        if (raw.length > 32000)
            throw invalid();
        raw = JSON.parse(raw);
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(k => k !== 'entries'))
        throw invalid();
    const entries = (raw as {
        entries: unknown;
    }).entries;
    if (!Array.isArray(entries) || entries.length > 24)
        throw invalid();
    const seen = new Set<string>();
    return entries.map(e => {
        if (!e || typeof e !== 'object' || Object.keys(e).some(k => !['id', 'kind', 'text', 'sourceMessageIds'].includes(k)) || !['fact', 'decision', 'task'].includes(e.kind) || typeof e.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(e.id) || seen.has(e.id))
            throw invalid();
        seen.add(e.id);
        if (!Array.isArray(e.sourceMessageIds) || !e.sourceMessageIds.length || e.sourceMessageIds.length > 8 || e.sourceMessageIds.some((x: unknown) => typeof x !== 'string' || !x || x.length > 200))
            throw invalid();
        return { id: e.id, kind: e.kind, text: clean(e.text, 600), sourceMessageIds: [...new Set<string>(e.sourceMessageIds)] };
    });
}
export class NativeKnowledge {
    constructor(readonly db: Database) {
        db.run(`CREATE TABLE IF NOT EXISTS native_projects(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,title TEXT NOT NULL,created INTEGER NOT NULL,updated INTEGER NOT NULL);
 CREATE INDEX IF NOT EXISTS native_project_owner ON native_projects(user_id,updated);
 CREATE TABLE IF NOT EXISTS native_project_chats(conversation_id TEXT PRIMARY KEY,project_id TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS native_chat_knowledge(conversation_id TEXT PRIMARY KEY,revision INTEGER NOT NULL,entries TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS native_knowledge_proposals(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,conversation_id TEXT NOT NULL,entry_id TEXT NOT NULL,revision INTEGER NOT NULL,entry TEXT NOT NULL,UNIQUE(project_id,conversation_id,entry_id));
 CREATE TABLE IF NOT EXISTS native_knowledge_rejections(project_id TEXT NOT NULL,conversation_id TEXT NOT NULL,entry_id TEXT NOT NULL,fingerprint TEXT NOT NULL,updated INTEGER NOT NULL,PRIMARY KEY(project_id,conversation_id,entry_id));
 CREATE TABLE IF NOT EXISTS native_project_knowledge(project_id TEXT NOT NULL,conversation_id TEXT NOT NULL,entry_id TEXT NOT NULL,entry TEXT NOT NULL,approved INTEGER NOT NULL,PRIMARY KEY(project_id,conversation_id,entry_id));`);
    }
    private own(user: string, chat: string) { if (!this.db.query('SELECT 1 FROM conversations WHERE id=? AND user_id=?').get(chat, user))
        throw new Error('knowledge_not_found'); }
    private project(user: string, id: string): KnowledgeProject { const r = this.db.query('SELECT id,title,created,updated FROM native_projects WHERE id=? AND user_id=?').get(id, user) as KnowledgeProject | null; if (!r)
        throw new Error('knowledge_not_found'); return r; }
    projects(user: string): KnowledgeProject[] { return this.db.query('SELECT id,title,created,updated FROM native_projects WHERE user_id=? ORDER BY updated DESC,id').all(user) as KnowledgeProject[]; }
    createProject(user: string, title: string) { title = clean(title, 100); return this.db.transaction(() => { if (this.projects(user).length >= 100)
        throw new Error('knowledge_limit'); const id = randomUUID(), now = Date.now(); this.db.query('INSERT INTO native_projects VALUES(?,?,?,?,?)').run(id, user, title, now, now); return this.project(user, id); })(); }
    renameProject(user: string, id: string, title: string) { this.project(user, id); this.db.query('UPDATE native_projects SET title=?,updated=? WHERE id=? AND user_id=?').run(clean(title, 100), Date.now(), id, user); return this.project(user, id); }
    deleteProject(user: string, id: string) { this.db.transaction(() => { this.project(user, id); for (const table of ['native_project_chats', 'native_knowledge_proposals', 'native_project_knowledge', 'native_knowledge_rejections'])
        this.db.query(`DELETE FROM ${table} WHERE project_id=?`).run(id); this.db.query('DELETE FROM native_projects WHERE id=? AND user_id=?').run(id, user); })(); }
    projectForChat(user: string, chat: string): KnowledgeProject | null { this.own(user, chat); return this.db.query('SELECT p.id,p.title,p.created,p.updated FROM native_projects p JOIN native_project_chats c ON c.project_id=p.id WHERE c.conversation_id=? AND p.user_id=?').get(chat, user) as KnowledgeProject | null; }
    assignProject(user: string, chat: string, project: string | null) { this.db.transaction(() => { this.own(user, chat); if (project !== null)
        this.project(user, project); if (this.projectForChat(user, chat)?.id === project)
        return; this.db.query('DELETE FROM native_knowledge_proposals WHERE conversation_id=?').run(chat); this.db.query('DELETE FROM native_project_chats WHERE conversation_id=?').run(chat); if (project !== null)
        this.db.query('INSERT INTO native_project_chats VALUES(?,?)').run(chat, project); })(); }
    snapshot(user: string, chat: string) {
        this.own(user, chat);
        const r = this.db.query('SELECT revision,entries FROM native_chat_knowledge WHERE conversation_id=?').get(chat) as {
            revision: number;
            entries: string;
        } | null;
        const project = this.projectForChat(user, chat);
        const projectEntries = project ? (this.db.query('SELECT conversation_id,entry,approved FROM native_project_knowledge WHERE project_id=? ORDER BY approved DESC,conversation_id,entry_id').all(project.id) as {
            conversation_id: string;
            entry: string;
            approved: number;
        }[]).map(x => ({ ...JSON.parse(x.entry) as KnowledgeEntry, sourceConversationId: x.conversation_id, approved: x.approved })) : [];
        const proposals: KnowledgeProposal[] = project ? (this.db.query('SELECT * FROM native_knowledge_proposals WHERE project_id=? AND conversation_id=? ORDER BY id').all(project.id, chat) as {
            id: string;
            project_id: string;
            conversation_id: string;
            revision: number;
            entry: string;
        }[]).map(x => ({ id: x.id, projectId: x.project_id, conversationId: x.conversation_id, revision: x.revision, entry: JSON.parse(x.entry) as KnowledgeEntry })) : [];
        return { revision: r?.revision ?? 0, entries: r ? JSON.parse(r.entries) as KnowledgeEntry[] : [], project, projectEntries, proposals };
    }
    updateChat(user: string, chat: string, revision: number, entries: KnowledgeEntry[]): boolean { const valid = parseKnowledgeUpdate({ entries }); if (!Number.isSafeInteger(revision) || revision < 0)
        throw invalid(); return this.db.transaction(() => { this.own(user, chat); if (this.snapshot(user, chat).revision !== revision)
        return false; for (const e of valid)
        for (const id of e.sourceMessageIds)
            if (!this.db.query('SELECT 1 FROM conversation_messages WHERE id=? AND conversation_id=?').get(id, chat))
                throw new Error('invalid_knowledge_source'); this.db.query('INSERT INTO native_chat_knowledge VALUES(?,?,?) ON CONFLICT(conversation_id) DO UPDATE SET revision=excluded.revision,entries=excluded.entries').run(chat, revision + 1, JSON.stringify(valid)); this.db.query('DELETE FROM native_knowledge_proposals WHERE conversation_id=?').run(chat); return true; })(); }
    /** Automatic suggestions respect previous decisions; explicit manual proposals can override. */
    shouldAutoPropose(user: string, chat: string, entryId: string): boolean {
        const s = this.snapshot(user, chat);
        const entry = s.entries.find(e => e.id === entryId);
        if (!s.project || !entry || s.proposals.some(p => p.entry.id === entryId)) return false;
        const hash = fingerprint(entry);
        const approved = s.projectEntries.find(e => e.sourceConversationId === chat && e.id === entryId);
        if (approved && fingerprint(approved) === hash) return false;
        const rejected = this.db.query('SELECT fingerprint FROM native_knowledge_rejections WHERE project_id=? AND conversation_id=? AND entry_id=?').get(s.project.id, chat, entryId) as { fingerprint: string } | null;
        return rejected?.fingerprint !== hash;
    }
    propose(user: string, chat: string, entryId: string): KnowledgeProposal { return this.db.transaction(() => { const s = this.snapshot(user, chat), entry = s.entries.find(e => e.id === entryId); if (!entry || !s.project)
        throw new Error('knowledge_not_found'); const old = this.db.query('SELECT id FROM native_knowledge_proposals WHERE project_id=? AND conversation_id=? AND entry_id=?').get(s.project.id, chat, entryId) as {
        id: string;
    } | null; if (!old && (this.db.query('SELECT COUNT(*) AS n FROM native_knowledge_proposals WHERE project_id=?').get(s.project.id) as {n:number}).n >= 100)
        throw new Error('knowledge_limit'); const p = { id: old?.id ?? randomUUID(), projectId: s.project.id, conversationId: chat, entry, revision: s.revision }; this.db.query('INSERT INTO native_knowledge_proposals VALUES(?,?,?,?,?,?) ON CONFLICT(project_id,conversation_id,entry_id) DO UPDATE SET revision=excluded.revision,entry=excluded.entry').run(p.id, p.projectId, chat, entryId, s.revision, JSON.stringify(entry)); return p; })(); }
    decide(user: string, id: string, accept: boolean): boolean { return this.db.transaction(() => { const r = this.db.query('SELECT q.* FROM native_knowledge_proposals q JOIN native_projects p ON p.id=q.project_id JOIN conversations c ON c.id=q.conversation_id WHERE q.id=? AND p.user_id=? AND c.user_id=?').get(id, user, user) as {
        project_id: string;
        conversation_id: string;
        entry_id: string;
        revision: number;
        entry: string;
    } | null; if (!r)
        return false; const s = this.snapshot(user, r.conversation_id); if (s.project?.id !== r.project_id || s.revision !== r.revision)
        return false; if (accept) {
        const exists = this.db.query('SELECT 1 FROM native_project_knowledge WHERE project_id=? AND conversation_id=? AND entry_id=?').get(r.project_id, r.conversation_id, r.entry_id);
        if (!exists && s.projectEntries.length >= 100)
            throw new Error('knowledge_limit');
        this.db.query('INSERT INTO native_project_knowledge VALUES(?,?,?,?,?) ON CONFLICT(project_id,conversation_id,entry_id) DO UPDATE SET entry=excluded.entry,approved=excluded.approved').run(r.project_id, r.conversation_id, r.entry_id, r.entry, Date.now());
    } else {
        this.db.query('INSERT INTO native_knowledge_rejections VALUES(?,?,?,?,?) ON CONFLICT(project_id,conversation_id,entry_id) DO UPDATE SET fingerprint=excluded.fingerprint,updated=excluded.updated').run(r.project_id, r.conversation_id, r.entry_id, fingerprint(JSON.parse(r.entry) as KnowledgeEntry), Date.now());
        // Fixed per-project bound, including entries removed from later chat snapshots.
        this.db.query('DELETE FROM native_knowledge_rejections WHERE project_id=? AND rowid NOT IN (SELECT rowid FROM native_knowledge_rejections WHERE project_id=? ORDER BY updated DESC,rowid DESC LIMIT 100)').run(r.project_id, r.project_id);
    } this.db.query('DELETE FROM native_knowledge_proposals WHERE id=?').run(id); return true; })(); }
    removeProjectEntry(user: string, project: string, chat: string, entry: string) { this.project(user, project); this.db.query('DELETE FROM native_project_knowledge WHERE project_id=? AND conversation_id=? AND entry_id=?').run(project, chat, entry); }
}
