// T-113: cold-storage export+prune of *_archive tables.
// Scoped to our own integer row-ids so it's robust to whatever other archive
// rows the shared test DB happens to contain.
import { test, expect, describe, afterEach } from "bun:test";
import { existsSync, rmSync, readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { db } from "../lib/db.ts";
import { exportColdStorage } from "../lib/cold-storage.ts";

const TMP = `/tmp/cold-test-${Math.floor(performance.now())}`;
const A = 990001, B = 990002, RECENT = 990003, DRY = 990004;
const IDS = [A, B, RECENT, DRY];

function seed(id: number, archivedAt: number) {
  // Literal SQL (no bound params). Values are test-controlled integers.
  db.prepare(
    `INSERT OR IGNORE INTO messages_archive
       (id, chat_id, agent_key, is_bot, from_user_id, from_name, text, ts, archived_at)
     VALUES (${id}, '-777', NULL, 0, 'u1', 'tester', 'hi', ${archivedAt}, ${archivedAt})`,
  ).run();
}
function present(id: number): boolean {
  return !!db.prepare(`SELECT 1 FROM messages_archive WHERE id=${id}`).get();
}

afterEach(() => {
  try { rmSync(TMP, { recursive: true, force: true }); } catch {}
  for (const id of IDS) db.prepare(`DELETE FROM messages_archive WHERE id=${id}`).run();
});

describe("cold-storage (T-113)", () => {
  test("exports rows older than cutoff to a gz file and prunes them", () => {
    const now = 1_900_000_000_000;
    const old = now - 400 * 86_400_000; // ~400 days old
    seed(A, old);
    seed(B, old);
    seed(RECENT, now - 10 * 86_400_000); // 10 days — must survive

    const res = exportColdStorage({ now, coldDays: 365, dir: TMP });
    const msgs = res.find((r) => r.table === "messages_archive")!;
    expect(msgs.file && existsSync(msgs.file)).toBe(true);

    expect(present(A)).toBe(false);
    expect(present(B)).toBe(false);
    expect(present(RECENT)).toBe(true);

    const dump = gunzipSync(readFileSync(msgs.file!)).toString("utf8");
    expect(dump.includes(String(A))).toBe(true);
    expect(dump.includes(String(B))).toBe(true);
  });

  test("prune:false exports but does NOT delete", () => {
    const now = 1_900_000_000_000;
    seed(DRY, now - 400 * 86_400_000);
    exportColdStorage({ now, coldDays: 365, dir: TMP, prune: false });
    expect(present(DRY)).toBe(true);
  });
});
