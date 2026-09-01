/**
 * Аудит 2026-08-28: настройки публикации читались через `??`, а systemd даёт «».
 *
 * `EnvironmentFile=` для строки `KEY=` кладёт ПУСТУЮ строку, а не отсутствие
 * ключа, — это записано в CLAUDE.md и уже ловилось на `lib/admin-commands.ts`.
 * Все три тула DeLabs поднимаются такими юнитами и читали свои настройки `??`:
 *
 *   process.env.DELABS_SITE_BASE ?? "https://delabs.space"    → ""
 *   Number(process.env.DELABS_CHANNEL_ID ?? "-1004471352065") → 0
 *
 * Дальше — прямо на пути в канал: адрес пункта «/digest/1» без схемы (Telegram
 * не отправляет ВЕСЬ пост), относительный fetch к API сайта, публикация в чат 0.
 *
 * Плюс шаблон окружения: `.env.example` обещал «Пусто = -1004471352065», а
 * DELABS_SITE_BASE и DELABS_DRAFTS_PENDING в нём не было вовсе — гейт полноты
 * шаблона не заглядывал в tools/, хотя systemd запускает именно оттуда.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { readFileSync } from "node:fs";
import {
  delabsChannelId,
  delabsSiteBase,
  delabsPendingPath,
  DEFAULT_DELABS_CHANNEL_ID,
  DEFAULT_DELABS_SITE_BASE,
  DEFAULT_DELABS_PENDING_PATH,
} from "../lib/delabs-env.ts";

const VARS = ["DELABS_CHANNEL_ID", "DELABS_SITE_BASE", "DELABS_DRAFTS_PENDING"] as const;
const saved = new Map<string, string | undefined>(VARS.map((v) => [v, process.env[v]]));

afterEach(() => {
  // Без восстановления env течёт в соседние файлы: bun гоняет каталог одним
  // процессом (CLAUDE.md §3.8 п.7).
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("предпосылки", () => {
  test("`??` не спасает от пустой строки, `||` — спасает", () => {
    const empty = "";
    expect(empty ?? "default").toBe("");
    expect(empty || "default").toBe("default");
  });

  test("Number(\"\") — это ноль, а не NaN", () => {
    // Поэтому пустой DELABS_CHANNEL_ID давал не «мусор, видно по логу», а
    // правдоподобный id чата 0.
    expect(Number("")).toBe(0);
    expect(Number.isFinite(Number(""))).toBe(true);
  });
});

describe("delabsChannelId", () => {
  test("пусто, пробелы и отсутствие — канал по умолчанию", () => {
    for (const raw of ["", "   "]) {
      process.env.DELABS_CHANNEL_ID = raw;
      expect(delabsChannelId()).toBe(DEFAULT_DELABS_CHANNEL_ID);
    }
    delete process.env.DELABS_CHANNEL_ID;
    expect(delabsChannelId()).toBe(DEFAULT_DELABS_CHANNEL_ID);
  });

  test("ноль и мусор не проходят: публиковать в чат 0 нельзя", () => {
    for (const raw of ["0", "-0", "abc", "-100abc"]) {
      process.env.DELABS_CHANNEL_ID = raw;
      expect(delabsChannelId()).toBe(DEFAULT_DELABS_CHANNEL_ID);
    }
  });

  test("заданный канал берётся как есть", () => {
    process.env.DELABS_CHANNEL_ID = "-1001234567890";
    expect(delabsChannelId()).toBe(-1001234567890);
  });
});

describe("delabsSiteBase", () => {
  test("пусто, пробелы и отсутствие — адрес по умолчанию", () => {
    for (const raw of ["", "  "]) {
      process.env.DELABS_SITE_BASE = raw;
      expect(delabsSiteBase()).toBe(DEFAULT_DELABS_SITE_BASE);
    }
    delete process.env.DELABS_SITE_BASE;
    expect(delabsSiteBase()).toBe(DEFAULT_DELABS_SITE_BASE);
  });

  test("адрес без схемы не выпускается наружу", () => {
    // `delabs.space/digest/1` Telegram считает адресом без протокола и роняет
    // весь пост, а не одну ссылку.
    for (const raw of ["delabs.space", "//delabs.space", "/", "ftp://delabs.space", "javascript:x"]) {
      process.env.DELABS_SITE_BASE = raw;
      expect(delabsSiteBase()).toBe(DEFAULT_DELABS_SITE_BASE);
    }
  });

  test("хвостовой слэш снимается: потребители клеят `${base}/digest/${id}`", () => {
    process.env.DELABS_SITE_BASE = "https://staging.delabs.space///";
    expect(delabsSiteBase()).toBe("https://staging.delabs.space");
    expect(`${delabsSiteBase()}/digest/1`).toBe("https://staging.delabs.space/digest/1");
  });

  test("рабочий адрес проходит, схема регистронезависима", () => {
    for (const [raw, want] of [
      ["https://delabs.space", "https://delabs.space"],
      ["http://127.0.0.1:8787", "http://127.0.0.1:8787"],
      ["HTTPS://Delabs.Space", "HTTPS://Delabs.Space"],
      ["  https://delabs.space  ", "https://delabs.space"],
    ] as const) {
      process.env.DELABS_SITE_BASE = raw;
      expect(delabsSiteBase()).toBe(want);
    }
  });
});

describe("delabsPendingPath", () => {
  test("пусто и отсутствие — путь по умолчанию", () => {
    process.env.DELABS_DRAFTS_PENDING = "";
    expect(delabsPendingPath()).toBe(DEFAULT_DELABS_PENDING_PATH);
    delete process.env.DELABS_DRAFTS_PENDING;
    expect(delabsPendingPath()).toBe(DEFAULT_DELABS_PENDING_PATH);
  });

  test("заданный путь берётся как есть", () => {
    process.env.DELABS_DRAFTS_PENDING = "/tmp/pending.json";
    expect(delabsPendingPath()).toBe("/tmp/pending.json");
  });
});

describe("применение", () => {
  const read = (p: string) => readFileSync(new URL(p, import.meta.url).pathname, "utf8");
  const TOOLS = ["../tools/daily-draft.ts", "../tools/approve-poll.ts", "../tools/weekly-draft.ts"];

  test("ни один тул больше не читает эти три переменные сам", () => {
    // Собираем строки-нарушители, а не сравниваем файл целиком: упавший
    // `toContain` печатает весь исходник и выносит вывод прогона.
    const hits: string[] = [];
    for (const p of TOOLS) {
      const lines = read(p)
        .split("\n")
        .filter((l) => !l.trimStart().startsWith("*") && !l.trimStart().startsWith("//"));
      for (const l of lines) {
        for (const v of VARS) {
          if (l.includes(`process.env.${v}`)) hits.push(`${p}: ${l.trim()}`);
        }
      }
    }
    expect(hits).toEqual([]);
  });

  test("канал у моста на сайт и у тулов — одна константа, а не две копии", () => {
    expect(read("../lib/site-ingest.ts")).toContain("DEFAULT_DELABS_CHANNEL_ID");
  });
});
