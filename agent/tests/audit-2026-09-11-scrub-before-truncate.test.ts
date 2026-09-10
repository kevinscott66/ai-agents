/**
 * Аудит 2026-09-11: обрезка ПЕРЕД скраббером.
 *
 * Почти все правила `scrubSecretString` требуют минимальной длины payload'а:
 * `TELEGRAM_TOKEN` — 30 символов после двоеточия, префиксные (`ghp_`,
 * `sk-ant-`, …) — 20, `SECRET_ASSIGNMENT` — 16, `CREDENTIAL_URL` —
 * замыкающую `@`. Обрезать сначала — значит отрезать хвост секрета, лишить
 * правило совпадения и выпустить наружу НАЧАЛО ключа, по которому его и
 * узнают. Каверза записана в докстроке `snapshotOf` (lib/mac-bridge.ts,
 * аудит 2026-08-13), но три места её всё-таки повторили:
 *
 *  1. `telegraf-patch.ts` — `log.warn("[telegram] swallowed", { msg:
 *     msg.slice(0, 200) })`. `log.*` чистит `data`, но уже обрезанный. Сюда
 *     приходят ровно сетевые отказы node-fetch, а у них в тексте URL Bot API
 *     вместе с токеном.
 *  2. `http.ts` — `scrubSecretString(`… ${body.slice(0, 160)}`)`: скраббер
 *     снаружи, `slice` внутри, то есть первым. Строка уезжает в
 *     `agent_actions.error` и админам через /api/actions (аудит 2026-08-27
 *     завёл здесь скраббер, но порядок оставил).
 *  3. `self-diag.ts` — `respText.slice(0, 200)` в `tasks.error` вообще без
 *     скраббера, хотя промпт несёт `failedError` и полный payload упавшего
 *     действия, а непарсящийся ответ модели обычно пересказывает вход.
 *
 * Правило теперь живёт вызовом (`scrubbedHead`), а не абзацем.
 */
import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { scrubSecretString, scrubbedHead } from "../lib/log.ts";
import { stripComments } from "./helpers/strip-comments.ts";

/** Токен бота: 10 цифр, двоеточие, 35 символов payload'а. */
const BOT_TOKEN = "7123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw";
/** Классический GitHub PAT: `ghp_` + 36 символов. */
const GH_TOKEN = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";

describe("scrubbedHead: скраб раньше обрезки", () => {
  test("секрет на границе обрезки не выживает", () => {
    const prefix = "x".repeat(175);
    const raw = `${prefix}${BOT_TOKEN} tail`;

    // Как было: обрезали, потом чистили. Двоеточие попадает в голову, а
    // хвоста payload'а не хватает на `{30,}` — и начало токена уходит как есть.
    const wrong = scrubSecretString(raw.slice(0, 200));
    expect(wrong).toContain("7123456789:AAHdqTcv");

    const right = scrubbedHead(raw, 200);
    expect(right).not.toContain("AAHdqTcv");
    expect(right).toContain("7123456789:***");
    expect(right.length).toBeLessThanOrEqual(200);
  });

  test("то же с префиксным ключом: остаётся тип, не значение", () => {
    // Пробел перед ключом обязателен: у `GITHUB_TOKEN` стоит `\b`, а между
    // буквой и `g` границы слова нет (та же ловушка, что описана у
    // `TELEGRAM_TOKEN` в lib/log.ts).
    const raw = `${"y".repeat(149)} ${GH_TOKEN}`;
    expect(scrubSecretString(raw.slice(0, 160))).toContain("ghp_A1b2C3");
    const right = scrubbedHead(raw, 160);
    expect(right).not.toContain("A1b2C3");
    expect(right).toContain("ghp_***");
  });

  test("короткая строка проходит насквозь, длина соблюдается", () => {
    expect(scrubbedHead("ничего секретного", 200)).toBe("ничего секретного");
    expect(scrubbedHead("z".repeat(500), 200)).toHaveLength(200);
  });
});

describe("вызывающие пользуются помощником, а не своим порядком", () => {
  const FILES = [
    "../lib/telegraf-patch.ts",
    "../lib/http.ts",
    "../lib/self-diag.ts",
    "../lib/health.ts",
    "../lib/safe-timer.ts",
  ];

  /** Код без комментариев: докстроки цитируют старую форму нарочно. */
  function code(rel: string): string {
    return stripComments(readFileSync(new URL(rel, import.meta.url), "utf8"));
  }

  test("ни в одном из мест обрезка не стоит перед скраббером", () => {
    for (const rel of FILES) {
      const src = code(rel);
      // `scrubSecretString(<что-то>.slice(…))` и `scrubSecretString(…).slice(…)`
      // — обе формы теперь запрещены: первая режет раньше, вторая дублирует
      // помощник.
      expect(src).not.toMatch(/scrubSecretString\([^)]*\.slice\(/);
      expect(src).not.toMatch(/scrubSecretString\([\s\S]{0,200}?\)\.slice\(/);
      expect(src).toContain("scrubbedHead(");
    }
  });

  test("ответ модели в self-diag больше не пишется в задачу сырым", () => {
    const src = code("../lib/self-diag.ts");
    expect(src).not.toContain("respText.slice(");
    expect(src).toContain("scrubbedHead(respText, 200)");
  });

  test("тело чужого ответа в http.ts чистится целиком", () => {
    const src = code("../lib/http.ts");
    expect(src).not.toContain("body.slice(");
    expect(src).toContain("scrubbedHead(body, 160)");
  });
});
