import { Database } from "bun:sqlite";
import {
  CommandSchema,
  EventSchema,
  WorldSchema,
  reduceEvent,
  type Command,
  type OfficeEvent,
  type World,
} from "../contracts/protocol";
import { mockAgent } from "../adapters/mock/scenarios";
export class OfficeStore {
  db: Database;
  world: World;
  listeners = new Set<(event: OfficeEvent) => void>();
  constructor(
    path = ":memory:",
    readonly retention = 512,
  ) {
    this.db = new Database(path);
    this.db.exec(
      "PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS projection (id INTEGER PRIMARY KEY, body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY, body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS commands (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result TEXT NOT NULL);",
    );
    const saved = this.db
      .query("SELECT body FROM projection WHERE id=1")
      .get() as { body: string } | null;
    this.world = saved
      ? WorldSchema.parse(JSON.parse(saved.body))
      : {
          schemaVersion: 1,
          streamId: crypto.randomUUID(),
          seq: 0,
          agent: mockAgent("CODING"),
          actions: [],
          messages: [],
        };
    if (!saved) this.persist();
  }
  private persist() {
    this.db
      .query("INSERT OR REPLACE INTO projection VALUES (1,?)")
      .run(JSON.stringify(this.world));
  }
  snapshot() {
    return structuredClone(this.world);
  }
  replay(streamId?: string, seq?: number): OfficeEvent[] | null {
    if (
      streamId !== this.world.streamId ||
      seq === undefined ||
      seq > this.world.seq
    )
      return null;
    if (seq === this.world.seq) return [];
    const rows = this.db
      .query("SELECT body FROM events WHERE seq > ? ORDER BY seq")
      .all(seq) as { body: string }[];
    const events = rows.map((r) => EventSchema.parse(JSON.parse(r.body)));
    return events[0]?.seq === seq + 1 ? events : null;
  }
  execute(input: Command) {
    const cmd = CommandSchema.parse(input),
      fingerprint = JSON.stringify(cmd);
    const old = this.db
      .query("SELECT fingerprint,result FROM commands WHERE id=?")
      .get(cmd.commandId) as { fingerprint: string; result: string } | null;
    if (old) {
      if (old.fingerprint !== fingerprint)
        throw new Error("idempotency_conflict");
      return JSON.parse(old.result) as {
        commandId: string;
        status: "completed";
        source: "mock";
      };
    }
    const emitted: OfficeEvent[] = [];
    const before = this.world;
    const result = {
      commandId: cmd.commandId,
      status: "completed" as const,
      source: "mock" as const,
    };
    try {
      this.db.transaction(() => {
        const at = new Date().toISOString();
        const append = (body: Pick<OfficeEvent, "type" | "payload">) => {
          const event = EventSchema.parse({
            ...body,
            schemaVersion: 1,
            streamId: this.world.streamId,
            seq: this.world.seq + 1,
            eventId: crypto.randomUUID(),
            timestamp: at,
            source: "mock",
          });
          this.world = reduceEvent(this.world, event);
          this.db
            .query("INSERT INTO events VALUES (?,?)")
            .run(event.seq, JSON.stringify(event));
          emitted.push(event);
        };
        if (cmd.kind === "scenario.set" || cmd.kind === "task.create") {
          const agent = mockAgent(
            cmd.kind === "scenario.set" ? cmd.state : "WAITING",
            at,
            this.world.agent,
          );
          if (cmd.kind === "task.create") {
            agent.runId = crypto.randomUUID();
            agent.taskId = cmd.commandId;
            agent.task = cmd.text;
            agent.summary =
              "Демо-задача добавлена в очередь. Реальный исполнитель не запущен.";
            agent.blocker = "Mock: задача не отправляется реальному агенту";
          }
          append({
            type: "agent.state.changed",
            payload: {
              agent,
              action: {
                id: crypto.randomUUID(),
                at,
                state: agent.state,
                summary: agent.summary,
              },
            },
          });
        } else {
          append({
            type: "chat.message",
            payload: {
              id: crypto.randomUUID(),
              commandId: cmd.commandId,
              agentId: "backend",
              speaker: "user",
              text: cmd.text,
              at,
              source: "mock",
            },
          });
          append({
            type: "chat.message",
            payload: {
              id: crypto.randomUUID(),
              commandId: cmd.commandId,
              agentId: "backend",
              speaker: "agent",
              text:
                "Это демонстрационный ответ Backend. Сообщение прошло через Gateway; LLM не вызывалась. Текущий сценарий: " +
                this.world.agent.state +
                ".",
              at,
              source: "mock",
            },
          });
        }
        this.persist();
        this.db
          .query("INSERT INTO commands VALUES (?,?,?)")
          .run(cmd.commandId, fingerprint, JSON.stringify(result));
        this.db
          .query("DELETE FROM events WHERE seq <= ?")
          .run(this.world.seq - this.retention);
      })();
    } catch (e) {
      this.world = before;
      throw e;
    }
    for (const event of emitted)
      for (const fn of this.listeners) {
        try {
          fn(event);
        } catch {
          /* A subscriber never breaks committed state. */
        }
      }
    return result;
  }
  result(id: string) {
    const row = this.db
      .query("SELECT result FROM commands WHERE id=?")
      .get(id) as { result: string } | null;
    return row ? JSON.parse(row.result) : null;
  }
  close() {
    this.db.close();
  }
}
