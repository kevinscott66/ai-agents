/**
 * Аудит 2026-08-12: между проверкой слота и записью pending — минуты ресёрча.
 *
 * `main()` спрашивает `pendingAwaitingApproval()` на строке 498, а пишет
 * pending на 591. Между ними `research()` (Agent SDK, maxTurns 12, WebSearch),
 * рендер баннера и две ходки в Telegram. Оба прогона, начавшиеся внутри этого
 * окна, проходят проверку. Замер на настоящих функциях (probe, прогон A —
 * таймер 08:00, прогон B — ручной запуск поверх него):
 *
 *   gate A: null | gate B: null
 *   после A: 4001
 *   после B: 4002 Дайджест B
 *   апрув на 4001 попадёт в pending? false
 *
 * Апрув ищут ТОЛЬКО по `pending.previewMsgId` (approve-poll.ts:570), поэтому:
 * ✅ на превью, которое владелец читал, не совпадает ни с чем и выпуск молча
 * пропадает; ✅ на втором — публикует в канал и на сайт статьи, которых он не
 * открывал. Плюс дневной ресёрч через SDK оплачивается дважды.
 *
 * Источник параллельности реальный: systemd дедуплицирует только свои старты, а
 * в шапке daily-draft.ts прямо написано «Запуск: bun tools/daily-draft.ts» —
 * ручной прогон про таймер не знает.
 *
 * Инвариант: слот занимается ДО ресёрча и атомарно; чужой pending не
 * перезаписывается никогда; брошенный замок не блокирует выпуск навсегда.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DRAFT_LOCK_MAX_AGE_MS,
  PENDING_MAX_AGE_MS,
  acquireDraftLock,
  commitPending,
  pendingAwaitingApproval,
  releaseDraftLock,
} from "../tools/daily-draft.ts";
import type { DraftArticle, PendingDraft } from "../tools/daily-draft.ts";

const TMP = mkdtempSync(join(tmpdir(), "delabs-concurrent-"));
const PENDING = join(TMP, "pending.json");
const LOCK = join(TMP, "pending.json.lock");

afterEach(() => {
  for (const p of [PENDING, LOCK]) {
    try {
      rmSync(p);
    } catch {}
  }
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

const NOW = Date.parse("2026-08-12T08:00:00.000Z");

function draft(previewMsgId: number, dayTitle: string, createdAt = NOW): PendingDraft {
  return {
    createdAt: new Date(createdAt).toISOString(),
    previewMsgId,
    dayTitle,
    articles: ARTICLES,
  };
}

const live = (): PendingDraft => JSON.parse(readFileSync(PENDING, "utf8"));

describe("слот выпуска занимается до ресёрча", () => {
  test("второй прогон внутри окна не получает замок — и не платит за ресёрч", () => {
    expect(acquireDraftLock(LOCK, NOW, "A")).toBeTruthy();
    // B стартует через 5 минут, пока A ещё ресёрчит.
    expect(acquireDraftLock(LOCK, NOW + 5 * 60_000, "B")).toBeNull();
  });

  test("после освобождения слот снова свободен", () => {
    releaseDraftLock(LOCK, acquireDraftLock(LOCK, NOW, "A"));
    expect(existsSync(LOCK)).toBe(false);
    expect(acquireDraftLock(LOCK, NOW + 60_000, "B")).toBeTruthy();
  });

  test("чужой замок не снимаем — его владелец ещё работает", () => {
    const a = acquireDraftLock(LOCK, NOW, "A");
    releaseDraftLock(LOCK, `${NOW}:B`); // B думает, что замок его
    expect(readFileSync(LOCK, "utf8")).toBe(a!);
    releaseDraftLock(LOCK, null); // и «нет токена» тоже ничего не трогает
    expect(existsSync(LOCK)).toBe(true);
  });

  test("брошенный замок (прогон убили по TimeoutStartSec) перехватывается", () => {
    acquireDraftLock(LOCK, NOW, "A");
    // На границе — ещё чужой.
    expect(acquireDraftLock(LOCK, NOW + DRAFT_LOCK_MAX_AGE_MS - 1, "B")).toBeNull();
    expect(acquireDraftLock(LOCK, NOW + DRAFT_LOCK_MAX_AGE_MS + 1, "B")).toBeTruthy();
  });

  test("мусор в файле замка не блокирует выпуск навсегда", () => {
    writeFileSync(LOCK, "не токен", "utf8");
    expect(acquireDraftLock(LOCK, NOW, "B")).toBeTruthy();
  });

  test("перехват сразу взводит замок заново — брошенный не достаётся всем сразу", () => {
    acquireDraftLock(LOCK, NOW, "A");
    const late = NOW + DRAFT_LOCK_MAX_AGE_MS + 1;
    const b = acquireDraftLock(LOCK, late, "B");
    expect(b).toBeTruthy();
    // C приходит в тот же момент: замок уже свежий, второго ресёрча не будет.
    expect(acquireDraftLock(LOCK, late, "C")).toBeNull();
    expect(readFileSync(LOCK, "utf8")).toBe(b!);
    // И C, не владея замком, снять его не может.
    releaseDraftLock(LOCK, `${late}:C`);
    expect(existsSync(LOCK)).toBe(true);
  });
});

describe("запись pending не затирает чужой черновик", () => {
  test("замер из шапки: апрув на 4001 больше не теряется", () => {
    expect(commitPending(draft(4001, "Дайджест A"), PENDING, NOW)).toBe(true);
    expect(live().previewMsgId).toBe(4001);

    // B прошёл проверку до записи A и дошёл до своей записи.
    expect(commitPending(draft(4002, "Дайджест B"), PENDING, NOW + 60_000)).toBe(false);
    expect(live().previewMsgId).toBe(4001);
    expect(live().dayTitle).toBe("Дайджест A");
  });

  test("свободный слот — пишем как раньше, целиком", () => {
    expect(commitPending(draft(4001, "Дайджест A"), PENDING, NOW)).toBe(true);
    const p = pendingAwaitingApproval(PENDING, NOW);
    expect(p?.previewMsgId).toBe(4001);
    expect(p?.articles).toEqual(ARTICLES);
  });

  test("протухший черновик записи не мешает", () => {
    const old = NOW - PENDING_MAX_AGE_MS - 60_000;
    writeFileSync(PENDING, JSON.stringify(draft(1, "вчера", old)), "utf8");
    expect(commitPending(draft(4002, "Дайджест B"), PENDING, NOW)).toBe(true);
    expect(live().previewMsgId).toBe(4002);
  });

  test("битый pending не блокирует выпуск навсегда", () => {
    writeFileSync(PENDING, "{не json", "utf8");
    expect(commitPending(draft(4002, "Дайджест B"), PENDING, NOW)).toBe(true);
    expect(live().previewMsgId).toBe(4002);
  });

  test("каталог создаётся, если его нет", () => {
    const deep = join(TMP, "нет", "такого", "pending.json");
    expect(commitPending(draft(7, "Дайджест"), deep, NOW)).toBe(true);
    expect(JSON.parse(readFileSync(deep, "utf8")).previewMsgId).toBe(7);
    rmSync(join(TMP, "нет"), { recursive: true, force: true });
  });
});
