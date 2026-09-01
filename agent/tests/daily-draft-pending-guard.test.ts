/**
 * Аудит 2026-08-12: две дыры на пути «черновик → ожидание апрува».
 *
 * 1) `previewMsgId = Number(sent?.id ?? 0)`. client.sendFile обычно отдаёт
 *    Message с `.id`, но на том же вызове может вернуться Updates, у которого
 *    `.id` нет вовсе — настоящий id лежит в updates[] (ровно тот случай, ради
 *    которого в lib/userbot.ts живёт extractMessageId). Замер:
 *      Number(sent?.id ?? 0) = 0   |   extractMessageId = 777
 *    previewMsgId=0 означает, что approve-poll ищет реакции и ответы на
 *    несуществующем сообщении: апрув владельца не совпадёт ни с чем никогда,
 *    черновик молча протухнет через сутки. Поэтому нулевой id — отказ на
 *    месте, а не запись pending, которую некому одобрить.
 *
 * 2) pending.json перезаписывался без единой проверки. Второй запуск
 *    daily-draft (таймер дёрнулся дважды, ручной прогон поверх ночного)
 *    затирал черновик, который владелец в этот момент читал: его апрув
 *    относился к превью со старым msgId, а в pending лежал уже новый — то
 *    есть одобрение просто пропадало, а дневной ресёрч через SDK оплачивался
 *    второй раз.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PENDING_MAX_AGE_MS,
  buildPending,
  pendingAwaitingApproval,
} from "../tools/daily-draft.ts";
import type { DraftArticle } from "../tools/daily-draft.ts";

const TMP = mkdtempSync(join(tmpdir(), "delabs-pending-"));
const PATH = join(TMP, "pending.json");

afterEach(() => {
  try {
    rmSync(PATH);
  } catch {}
});

const ARTICLES: DraftArticle[] = [
  {
    title: "Новость",
    date: "2026-08-12T09:00:00.000Z",
    summary: "s",
    body: "b",
    items: [],
    sourceCount: 2,
  },
];

describe("buildPending", () => {
  test("обычный Message — id как есть", () => {
    const p = buildPending({ id: 123 }, "Дайджест: день", ARTICLES);
    expect(p?.previewMsgId).toBe(123);
    expect(p?.dayTitle).toBe("Дайджест: день");
    expect(p?.articles).toEqual(ARTICLES);
    expect(Number.isNaN(Date.parse(p!.createdAt))).toBe(false);
  });

  test("ответ-Updates — id достаётся из updates[]", () => {
    const sent = { updates: [{ className: "UpdateMessageID", id: 777 }] };
    // Старое поведение: Number(sent?.id ?? 0) === 0.
    expect(buildPending(sent, "Дайджест", ARTICLES)?.previewMsgId).toBe(777);
  });

  test("id определить не удалось — pending не собираем", () => {
    for (const sent of [null, undefined, {}, { id: 0 }, { id: "нет" }]) {
      expect(buildPending(sent, "Дайджест", ARTICLES)).toBeNull();
    }
  });
});

function writePending(createdAt: string): void {
  writeFileSync(
    PATH,
    JSON.stringify({
      createdAt,
      previewMsgId: 5,
      dayTitle: "Дайджест: вчера",
      articles: ARTICLES,
    }),
    "utf8",
  );
}

describe("pendingAwaitingApproval", () => {
  const NOW = Date.parse("2026-08-12T09:00:00.000Z");

  test("файла нет — можно слать новый черновик", () => {
    expect(pendingAwaitingApproval(PATH, NOW)).toBeNull();
  });

  test("свежий черновик ждёт апрува — новый не шлём", () => {
    writePending("2026-08-12T06:00:00.000Z");
    const p = pendingAwaitingApproval(PATH, NOW);
    expect(p?.previewMsgId).toBe(5);
    expect(p?.dayTitle).toBe("Дайджест: вчера");
  });

  test("на границе суток ещё считается живым", () => {
    writePending(new Date(NOW - PENDING_MAX_AGE_MS + 60_000).toISOString());
    expect(pendingAwaitingApproval(PATH, NOW)).not.toBeNull();
  });

  test("протухший (>24ч) не блокирует — approve-poll его сам удалит", () => {
    writePending(new Date(NOW - PENDING_MAX_AGE_MS - 60_000).toISOString());
    expect(pendingAwaitingApproval(PATH, NOW)).toBeNull();
  });

  test("битый файл не блокирует навсегда", () => {
    writeFileSync(PATH, "{не json", "utf8");
    expect(pendingAwaitingApproval(PATH, NOW)).toBeNull();
    writePending("вчера вечером");
    expect(pendingAwaitingApproval(PATH, NOW)).toBeNull();
  });
});
