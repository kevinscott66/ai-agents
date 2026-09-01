/**
 * Аудит 2026-08-19 — дыры, найденные четырьмя параллельными прогонами.
 *
 * Каждый describe ниже фиксирует ровно тот сценарий, при котором старый код
 * вёл себя неправильно, — чтобы починка не откатилась вместе с рефакторингом.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { db } from "../lib/db.ts";
import { archiveOldRows } from "../lib/db-maint.ts";
import { DAY_MS } from "../lib/time-constants.ts";
import { clientIpKey } from "../lib/http-utils.ts";
import { htmlPartFits } from "../lib/telegram-chunking.ts";
import { isChannelFooterLine, ensureChannelFooter, CHANNEL_FOOTER } from "../lib/channel-footer.ts";
import { mdToTelegramHtml } from "../lib/telegram-format.ts";

// ---------------------------------------------------------------------------
// 1) archiveOldRows: падение одного шага не уносит два остальных
// ---------------------------------------------------------------------------

const CHAT_NUM = -1009190819;
const NOW = 1_800_000_000_000;
const OLD = NOW - 400 * DAY_MS;

function cleanupArchive(): void {
  for (const t of [
    "agent_actions",
    "agent_actions_archive",
    "audit_logs",
    "audit_logs_archive",
  ]) {
    db.prepare(`DELETE FROM ${t} WHERE chat_id = ?`).run(CHAT_NUM);
  }
  db.prepare(`DROP TRIGGER IF EXISTS _t20260819_block_actions_archive`).run();
}

describe("db-maint: шаги архивации изолированы друг от друга", () => {
  beforeEach(cleanupArchive);
  afterEach(cleanupArchive);

  test("сбой на agent_actions не отменяет архивацию audit_logs", () => {
    db.prepare(
      `INSERT INTO agent_actions (agent_key, chat_id, action_type, payload, status, created_at)
       VALUES ('qa', ?, 'SEND_MESSAGE', '{}', 'done', ?)`,
    ).run(CHAT_NUM, OLD);
    // id обязателен: у audit_logs он TEXT PRIMARY KEY, а такой столбец в
    // SQLite принимает NULL — строка без id скопировалась бы в архив и НЕ
    // удалилась (`a.id = audit_logs.id` на NULL не совпадает). Оба реальных
    // писателя (alerting.ts, dispatch/agent-prompt.ts) id проставляют.
    db.prepare(
      `INSERT INTO audit_logs (id, agent_key, chat_id, event_type, payload, created_at)
       VALUES ('t20260819-audit-1', 'qa', ?, 'test.event', '{}', ?)`,
    ).run(CHAT_NUM, OLD);

    // Единственный способ воспроизвести отказ ровно первого шага без подмены
    // модуля: источник сбоя тот же, что в проде (ошибка на INSERT в архив).
    db.prepare(
      `CREATE TRIGGER _t20260819_block_actions_archive
       BEFORE INSERT ON agent_actions_archive
       BEGIN SELECT RAISE(ABORT, 'boom'); END`,
    ).run();

    // Ошибка всё ещё выходит наружу — на ней висит алерт
    // `db_maint.archive_failed` в runDaily.
    expect(() => archiveOldRows({ now: NOW, olderThanDays: 90 })).toThrow(
      /agent_actions/,
    );

    // Упавший шаг ничего не удалил…
    expect(
      (
        db
          .prepare(`SELECT count(*) AS n FROM agent_actions WHERE chat_id = ?`)
          .get(CHAT_NUM) as { n: number }
      ).n,
    ).toBe(1);

    // …а следующий всё равно отработал. До починки сюда не доходило вовсе:
    // исключение уходило вызывающему сразу, а runDaily уже поставил суточный
    // маркер, то есть audit_logs и approvals пропускали целые сутки.
    expect(
      (
        db
          .prepare(`SELECT count(*) AS n FROM audit_logs WHERE chat_id = ?`)
          .get(CHAT_NUM) as { n: number }
      ).n,
    ).toBe(0);
    expect(
      (
        db
          .prepare(
            `SELECT count(*) AS n FROM audit_logs_archive WHERE chat_id = ?`,
          )
          .get(CHAT_NUM) as { n: number }
      ).n,
    ).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 2) clientIpKey: неизвестный peer больше не наследует путь доверенного прокси
// ---------------------------------------------------------------------------

describe("clientIpKey: неизвестный источник не получает личное ведро", () => {
  test("peer=null игнорирует X-Forwarded-For целиком", () => {
    // Раньше `peer === null` шёл по ветке loopback: клиент сам дописывал
    // последний элемент XFF и вращением получал свежее ведро на каждый запрос,
    // то есть лимит не действовал вовсе.
    expect(clientIpKey("1.2.3.4, 203.0.113.9", null)).toBe("anon:unknown");
    expect(clientIpKey("203.0.113.10", null)).toBe("anon:unknown");
    expect(clientIpKey(null, null)).toBe("anon:unknown");

    // Вращение больше не даёт разных ключей.
    const keys = new Set(
      ["a", "b", "c"].map((s) => clientIpKey(`10.0.0.1, ${s}`, null)),
    );
    expect(keys.size).toBe(1);
  });

  test("loopback-peer по-прежнему доверяет последнему элементу XFF", () => {
    expect(clientIpKey("1.2.3.4, 203.0.113.9", "127.0.0.1")).toBe(
      "anon:203.0.113.9",
    );
    expect(clientIpKey("9.9.9.9", "::ffff:127.0.0.1")).toBe("anon:9.9.9.9");
    expect(clientIpKey(null, "::1")).toBe("anon:::1");
  });

  test("не-loopback peer идентифицируется собой, а не заголовком", () => {
    expect(clientIpKey("evil", "198.51.100.7")).toBe("anon:198.51.100.7");
  });
});

// ---------------------------------------------------------------------------
// 3) htmlPartFits: вторая граница опциональна
// ---------------------------------------------------------------------------

describe("htmlPartFits: жёсткая граница по сырой длине — опция", () => {
  const rich = `[${"x".repeat(15)}](https://delabs.space/very/long/path/indeed)`;

  test("без hardLimit считается только видимая длина", () => {
    expect(rich.length).toBeGreaterThan(20);
    expect(htmlPartFits(20)(rich)).toBe(true);
  });

  test("с hardLimit сырая длина всё ещё режет", () => {
    const fits = htmlPartFits(20, 30);
    expect(fits(rich)).toBe(false);
    expect(fits("короткий")).toBe(true);
  });

  test("видимая длина считается всегда", () => {
    expect(htmlPartFits(5)("x".repeat(6))).toBe(false);
    expect(htmlPartFits(5, 9999)("x".repeat(6))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4) isChannelFooterLine: 💬 сам по себе не делает строку подвалом
// ---------------------------------------------------------------------------

describe("channel-footer: 💬 из словаря эмодзи не съедает CTA", () => {
  test("обычный призыв к комментариям остаётся в тексте", () => {
    // 💬 есть в брендовом словаре кастомных эмодзи, поэтому агенты ставят его
    // в живом тексте. Строка удалялась и заменялась каноническим подвалом уже
    // ПОСЛЕ того, как владелец одобрил пост.
    const cta = "💬 Что думаете? Пишите в комментариях";
    expect(isChannelFooterLine(cta)).toBe(false);

    const post = `Заголовок\n\nТекст поста.\n\n${cta}`;
    expect(ensureChannelFooter(post)).toBe(post);
  });

  test("настоящий подвал по-прежнему опознаётся", () => {
    expect(isChannelFooterLine("💬 Чат: https://t.me/delabs_chat")).toBe(true);
    expect(isChannelFooterLine("© DeLabs🤑 2026")).toBe(true);
    expect(isChannelFooterLine("Copyright © 2026 DeLabs")).toBe(true);
    expect(
      isChannelFooterLine("💬 Активности: https://delabs-team.notion.site/x"),
    ).toBe(true);
  });

  test("подвал заменяется на канонический, а тело поста цело", () => {
    const post = "Текст поста.\n\n💬 Чат: https://t.me/delabs_chat";
    const out = ensureChannelFooter(post);
    expect(out).toBe(`Текст поста.\n\n${CHANNEL_FOOTER}`);
    // Идемпотентность: второй прогон ничего не меняет.
    expect(ensureChannelFooter(out)).toBe(out);
  });
});

// ---------------------------------------------------------------------------
// 5) mdToTelegramHtml: подделанный плейсхолдер не крадёт чужую ссылку
// ---------------------------------------------------------------------------

/** U+0000 — обёртка наших внутренних плейсхолдеров. Пишем
 *  конструктором, а не литералом: сырой байт в исходнике ловит
 *  tests/t811-no-raw-nul.test.ts (git и grep считают такой файл бинарным). */
const NUL = String.fromCharCode(0);

describe("telegram-format: плейсхолдеры не подделываются извне", () => {
  test("подделка не забирает href настоящей ссылки", () => {
    // Вход недоверенный: тела вложений READ_FILE и выдача web_search приходят
    // в текст как есть. Раньше `${NUL}U0${NUL}` разворачивался в URL первой
    // НАСТОЯЩЕЙ ссылки поста — читателю уходили две ссылки на один адрес.
    const out = mdToTelegramHtml(
      `${NUL}U0${NUL} и [док](https://delabs.space/real)`,
    );
    expect(out).toContain('href="https://delabs.space/real"');
    expect(out.match(/href=/g)?.length).toBe(1);
    expect(out).not.toContain("https://delabs.space/real</a> и");
    expect(out).not.toContain(NUL);
    expect(out).not.toContain("undefined");
  });

  test("подделка без единой настоящей ссылки не даёт литерал undefined", () => {
    for (const kind of ["U", "I", "B"]) {
      const out = mdToTelegramHtml(`нажми ${NUL}${kind}0${NUL} сюда`);
      expect(out).not.toContain("undefined");
      expect(out).not.toContain(NUL);
      expect(out).not.toContain("<a href");
    }
  });

  test("обычное форматирование не сломано", () => {
    const out = mdToTelegramHtml(
      "**жирный** и `код` и [ссылка](https://x.io/a_b_c)",
    );
    expect(out).toContain("<b>жирный</b>");
    expect(out).toContain("<code>код</code>");
    expect(out).toContain('href="https://x.io/a_b_c"');
  });
});
