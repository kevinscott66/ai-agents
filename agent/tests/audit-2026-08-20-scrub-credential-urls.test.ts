/**
 * Аудит 2026-08-20: скраббер секретов не ловил ту самую форму, ради которой
 * его зовут из mac-bridge.
 *
 * Комментарий к `snapshotOf` в lib/mac-bridge.ts называет мотивирующий
 * случай дословно: «`git push` по HTTPS печатает в stderr URL вида
 * `https://x-access-token:ghp_…@github.com/…`». Это вывод произвольной
 * программы, запущенной `claude` на машине владельца, и уходит он двумя
 * дорогами — в чат (хвост 3500 символов) и в `agent_actions.error`, то есть на
 * диск в SQLite и наружу админам через `/api/actions`.
 *
 * Правил в `scrubSecretString` было три: query-параметры, `Bearer …` и токен
 * Telegram-бота. Ни одно из них credential-URL не покрывает, как и `ghp_`,
 * `github_pat_`, `sk-ant-`, `sk-`. То есть постоянная защита («ALWAYS on —
 * secrets must never log») в этой форме отсутствовала.
 *
 * Определений «как выглядит секрет» в репо два, и второе — строже:
 * `deploy/vps-autonomous/scan-staged-secrets.sh:27-34`, шесть шаблонов. На
 * выходной границе стояло более слабое. Здесь они сводятся.
 *
 * Инвариант: секрет не покидает процесс; при этом обычный текст не портится —
 * скруббер стоит на диагностическом выводе, и ложное срабатывание ломает
 * разбор падений.
 */
import { describe, test, expect } from "bun:test";
import { scrubSecretString } from "../lib/log.ts";

/**
 * Значения синтетические, но по форме настоящие: короче — и шаблон честно не
 * сработает, а тест будет проверять не то.
 */
const GHP = "ghp_" + "A1bC2dE3fG4hI5jK6lM7nO8pQ9rS0tU1vW2x";
const PAT_FG = "github_pat_" + "11ABCDEFG0" + "aBcDeFgHiJkLmNoPqRsTuVwXyZ012345";
const ANT = "sk-ant-api03-" + "AbCdEf_ghIJKlmnop-qrstuv123456";
const OAI = "sk-" + "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789ABCDEF";

describe("scrubSecretString: формы, до которых он не доставал", () => {
  test("credential-URL из stderr `git push` — пароль вырезан, остальное цело", () => {
    const out = scrubSecretString(
      `fatal: unable to access 'https://x-access-token:${GHP}@github.com/kevinscott66/ai-agents.git/'`,
    );
    expect(out).not.toContain(GHP);
    // Диагностика обязана остаться читаемой: кто и куда ходил — видно.
    expect(out).toContain("x-access-token");
    expect(out).toContain("github.com/kevinscott66/ai-agents.git");
  });

  test("GitHub PAT в свободном тексте", () => {
    const out = scrubSecretString(`gh auth failed with token ${GHP} (401)`);
    expect(out).not.toContain(GHP);
    expect(out).toContain("ghp_***");
    expect(out).toContain("(401)");
  });

  test("fine-grained PAT", () => {
    const out = scrubSecretString(`Authorization failed: ${PAT_FG}`);
    expect(out).not.toContain(PAT_FG);
    expect(out).toContain("github_pat_***");
  });

  test("ключ Anthropic из упавшего окружения", () => {
    const out = scrubSecretString(`Error: ANTHROPIC_API_KEY=${ANT} is invalid`);
    expect(out).not.toContain(ANT);
    expect(out).toContain("sk-ant-***");
  });

  test("ключ OpenAI", () => {
    const out = scrubSecretString(`openai: 401 for ${OAI}`);
    expect(out).not.toContain(OAI);
    expect(out).toContain("sk-***");
  });
});

describe("прежние правила не сломаны", () => {
  test("Bearer", () => {
    expect(scrubSecretString("Authorization: Bearer abc.def-123")).toBe(
      "Authorization: Bearer ***",
    );
  });

  test("токен Telegram-бота в URL — bot_id остаётся", () => {
    const out = scrubSecretString(
      "request to https://api.telegram.org/bot7123456789:AAHqwertyuiopasdfghjklzxcvbnm12345678/getMe failed",
    );
    expect(out).toContain("7123456789:***");
    expect(out).not.toContain("AAHqwertyuiopasdfghjklzxcvbnm12345678");
  });

  test("секрет в query-параметре", () => {
    const out = scrubSecretString("GET /api/stream?initdata=user%3D42%26hash%3Dabc");
    expect(out).toContain("initdata=***");
  });
});

describe("ложных срабатываний нет — вывод остаётся разбираемым", () => {
  test("обычный текст не тронут", () => {
    for (const s of [
      "sk-ip это не ключ, версия 1.2.3",
      "postgres://localhost:5432/db",
      "смотри https://github.com/kevinscott66/ai-agents/pull/459",
      "ghp_ (пустой префикс без значения)",
      "commit ghp короткий",
    ]) {
      expect(scrubSecretString(s)).toBe(s);
    }
  });

  test("URL без пароля не трогается", () => {
    const s = "clone https://github.com/o/r.git into /opt/agent-team";
    expect(scrubSecretString(s)).toBe(s);
  });
});

describe("скраббер линеен по длине входа", () => {
  /**
   * Скраббер зовут на потоке с мака (`snapshotOf`, lib/mac-bridge.ts) — это
   * вывод произвольной программы, до нескольких мегабайт, и считается он в том
   * же процессе, где 12 ботов и HTTP Mini App.
   *
   * Прогон из букв БЕЗ `://` — худший случай для правила про credential-URL:
   * жадная часть про схему съедает его целиком и отступает по символу. Пока в
   * регулярке стояла `*`, это давало ровно квадрат: 8 КБ → 64 мс, 16 КБ → 261
   * мс, 32 КБ → 1043 мс, а тест `mac-bridge-stream-cap` с его 4 МБ вырастал с
   * 50 мс до 4-6 секунд и начинал флакать.
   *
   * Порог намеренно щедрый: с границей `{0,30}` здесь единицы миллисекунд, без
   * неё — секунды. Между ними два порядка, так что тест ловит возврат `*`, а не
   * загруженность машины.
   */
  test("64 КБ без `://` не уводят в квадрат", () => {
    const started = performance.now();
    const out = scrubSecretString("A".repeat(64_000));
    const ms = performance.now() - started;
    expect(out.length).toBe(64_000); // ничего не вырезано — секрета там нет
    expect(ms).toBeLessThan(1_000);
  });

  test("граница схемы не мешает вырезать пароль из реального URL", () => {
    // `git+ssh` — самая длинная схема, что встречается на деле (7 символов).
    expect(scrubSecretString("git+ssh://user:s3cret@host/repo.git")).toBe(
      "git+ssh://user:***@host/repo.git",
    );
  });
});
