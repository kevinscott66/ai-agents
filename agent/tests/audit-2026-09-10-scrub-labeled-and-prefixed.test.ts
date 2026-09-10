/**
 * Аудит 2026-09-10: скраббер знал две формы записи секрета из трёх.
 *
 * Были `ИМЯ=значение` (форма `.env`, аудит 2026-08-28) и `?имя=значение`
 * (форма URL). Не было формы с двоеточием — а именно она выходит из всего, что
 * печатает заголовки и структуры: `X-Api-Key: …` из `curl -v`,
 * `{"token":"…"}` из тела чужой ошибки, `password: …` из YAML. Плюс в
 * query-строке имя сверялось с началом параметра, то есть `?refresh_token=` и
 * `&client_secret=` — формы настоящих OAuth-редиректов — не совпадали ни с
 * одной альтернативой.
 *
 * Куда течёт: `scrubSecretString` стоит на выходной границе — `snapshotOf`
 * (mac-bridge.ts) для stdout/stderr произвольной команды с мака,
 * `agent_actions.error` и снапшот health. То есть незакрытая форма уезжает в
 * чат, в SQLite и наружу админам через `/api/actions` и SSE. Инвариант в шапке
 * lib/log.ts — «ALWAYS on — secrets must never log».
 *
 * Тест держит и обратную сторону — то, что маскировать НЕ надо: голые `key:`,
 * `session:`, время `12:30:05` и строчное `password=` (граница, закреплённая
 * аудитом 2026-08-28: скрипт-сканер ищет без -i). Правило с двоеточием
 * намеренно уже списка для query-строки, и эта разница — предмет теста, а не
 * случайность.
 */
import { describe, expect, test } from "bun:test";
import { scrubSecretString } from "../lib/log.ts";

describe("форма `имя: значение`", () => {
  test("свой заголовок с ключом — схемы нет, BEARER не помогал", () => {
    expect(scrubSecretString("X-Api-Key: abcdef1234567890")).toBe("X-Api-Key: ***");
    expect(scrubSecretString("X-Figma-Token: figd_abcdef")).toBe("X-Figma-Token: ***");
  });

  test("JSON из тела чужой ошибки", () => {
    expect(scrubSecretString('{"token":"t0ps3cret","user":"bob"}')).toBe(
      '{"token":"***","user":"bob"}',
    );
    expect(scrubSecretString('{"client_secret": "zzz-yyy"}')).toBe(
      '{"client_secret": "***"}',
    );
  });

  test("YAML", () => {
    expect(scrubSecretString("password: hunter2")).toBe("password: ***");
    expect(scrubSecretString("  api_key: abc123")).toBe("  api_key: ***");
  });

  test("тип авторизации остаётся виден", () => {
    // Схема входит в сохраняемую часть — иначе по логу не понять, чем именно
    // ходили. И ровно поэтому правило стоит ПЕРВЫМ: после BEARER оно бы
    // сработало на уже замаскированном значении и напечатало `*** ***`.
    expect(scrubSecretString("Authorization: Bearer abc.def.ghi")).toBe(
      "Authorization: Bearer ***",
    );
    expect(scrubSecretString("Authorization: Basic dXNlcjpwYXNz")).toBe(
      "Authorization: Basic ***",
    );
  });

  test("хост в credential-URL не съедается", () => {
    // `@` исключён из класса значения: имя хоста в логе нужно.
    expect(
      scrubSecretString("https://x-access-token:ghp_abcdefghijklmnop@github.com/x"),
    ).toBe("https://x-access-token:***@github.com/x");
  });
});

describe("границы формы с двоеточием", () => {
  test("голые `key`/`session`/`auth` не в списке — это обычные слова", () => {
    for (const s of ["unknown key: foo", "session: 42", "auth: ok"]) {
      expect(scrubSecretString(s)).toBe(s);
    }
  });

  test("время и адрес с портом не трогаются", () => {
    for (const s of [
      "time: 12:30:05",
      "error: connect ECONNREFUSED 127.0.0.1:8787",
    ]) {
      expect(scrubSecretString(s)).toBe(s);
    }
  });

  test("имя внутри слова не считается именем", () => {
    const s = "mytoken: value";
    expect(scrubSecretString(s)).toBe(s);
  });

  test("строчное `имя=значение` по-прежнему не трогается", () => {
    // Граница аудита 2026-08-28 (форма из .env, скрипт ищет без -i). Новое
    // правило ключуется на `:`, а не на `=`, и её не сдвигает.
    const s = "password=abcdefghijklmnopqrstuvwx";
    expect(scrubSecretString(s)).toBe(s);
  });
});

describe("приставки в query-строке", () => {
  test("OAuth-редирект: обе формы разом", () => {
    expect(
      scrubSecretString("https://h/cb?refresh_token=abc123&client_secret=zzz&state=ok"),
    ).toBe("https://h/cb?refresh_token=***&client_secret=***&state=ok");
  });

  test("подписанная ссылка", () => {
    expect(scrubSecretString("https://h/o?X-Amz-Signature=deadbeef&x-api-key=k1")).toBe(
      "https://h/o?X-Amz-Signature=***&x-api-key=***",
    );
  });

  test("приставка без разделителя именем не считается", () => {
    const s = "https://h/x?monkey=banana";
    expect(scrubSecretString(s)).toBe(s);
  });

  test("прежняя форма без приставки цела", () => {
    expect(scrubSecretString("https://h/x?token=abcdefghijklmnop")).toBe(
      "https://h/x?token=***",
    );
  });
});

describe("`curl -u user:password`", () => {
  test("пароль маскируется, пользователь остаётся", () => {
    expect(scrubSecretString("curl -u alice:s3cr3t https://h")).toBe(
      "curl -u alice:*** https://h",
    );
    expect(scrubSecretString("curl --user alice:s3cr3t https://h")).toBe(
      "curl --user alice:*** https://h",
    );
  });
});

describe("стоимость прогона линейна", () => {
  test("32 КБ мусора без единого секрета", () => {
    // Тот же класс, что закрывает `{0,30}` у CREDENTIAL_URL: приставка перед
    // обязательным разделителем без верхней границы даёт возврат по одному
    // символу с каждой стартовой позиции. Скраббер зовут на выводе чужой
    // программы в том же потоке, где 12 ботов и HTTP Mini App.
    const noise = "A".repeat(32768);
    const started = performance.now();
    scrubSecretString(noise);
    expect(performance.now() - started).toBeLessThan(200);
  });
});
