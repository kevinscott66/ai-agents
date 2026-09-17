/**
 * Аудит 2026-08-28: скраббер не знал формы `ИМЯ=значение`.
 *
 * Комментарий над правилами (lib/log.ts) утверждает прямо: «Формы взяты из
 * существующего определения „как выглядит секрет" в этом же репо —
 * deploy/vps-autonomous/scan-staged-secrets.sh. Определений и так было два, и
 * на выходной границе стояло более слабое; теперь они совпадают.»
 *
 * Они не совпадали. В скрипте семь форм, в `scrubSecretString` было
 * реализовано шесть: не хватало седьмой, `ИМЯ=значение` — той самой, которая
 * покрывает всё содержимое `.env` разом. Плюс современные ключи OpenAI
 * (`sk-proj-…`, `sk-svcacct-…`) не ловились ни там, ни там: правило требует
 * 40+ строго буквенно-цифровых символов сразу после `sk-`, а у них четвёртый
 * символ — дефис.
 *
 * Куда это течёт: `MAC_RUN_CLAUDE` гоняет на машине владельца произвольную
 * команду, и её stdout/stderr проходит через `scrubSecretString`
 * (lib/mac-bridge.ts) — `printenv`, упавший скрипт с `set -x`, дамп конфига.
 * Строка `TELEGRAM_SESSION=1BQ…` — это полноценная сессия юзербота — уходила
 * двумя дорогами, которые называет тот же комментарий: в чат и в
 * `agent_actions.error`, то есть на диск в SQLite и наружу админам через
 * /api/actions.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { scrubSecretString } from "../lib/log.ts";

/** Оба вторых определения «как выглядит секрет»: локальный гейт и CI. */
const SCRIPTS: Array<[string, string]> = [
  ["scan-staged-secrets.sh", "../../deploy/vps-autonomous/scan-staged-secrets.sh"],
  ["check-secret-hygiene.sh", "../../.github/scripts/check-secret-hygiene.sh"],
].map(([name, rel]) => [
  name as string,
  readFileSync(new URL(rel as string, import.meta.url), "utf-8"),
]);

/** Похоже на настоящую сессию gramjs: 1B + длинный base64. */
const SESSION = `1BQANOTEuMTA4LjU2LjE4NAG7xKlOaLmFbQtNu2r8${"aB9".repeat(12)}`;

/**
 * Настоящая StringSession длиннее: gramjs пишет туда ключ авторизации целиком,
 * и в живом `.env` строка идёт на три с лишним сотни символов. Короткая
 * `SESSION` выше проверяет форму `ИМЯ=значение`; эта — правило, которое ловит
 * сессию БЕЗ имени рядом, по одной только форме.
 */
const SESSION_BARE = `1B${"QaZwSx0129".repeat(30)}`;

describe("форма ИМЯ=значение", () => {
  test("сессия юзербота больше не уезжает целиком", () => {
    const out = scrubSecretString(`TELEGRAM_SESSION=${SESSION}`);
    expect(out).not.toContain(SESSION);
    expect(out).toContain("TELEGRAM_SESSION=");
    expect(out).toContain("***");
  });

  test("имя переменной остаётся — иначе по логу не понять, что светилось", () => {
    expect(scrubSecretString("INGEST_TOKEN=9f8c2b1a7d6e5f4c3b2a1908")).toBe(
      "INGEST_TOKEN=***",
    );
  });

  test("кавычки вокруг значения не мешают", () => {
    expect(
      scrubSecretString('MINIAPP_ADMIN_SECRET="s3cr3t-value-that-is-long-enough"'),
    ).toBe('MINIAPP_ADMIN_SECRET="***"');
    expect(
      scrubSecretString("MINIAPP_ADMIN_SECRET='s3cr3t-value-that-is-long-enough'"),
    ).toBe("MINIAPP_ADMIN_SECRET='***'");
  });

  test("пробелы вокруг равно не мешают", () => {
    expect(scrubSecretString("API_KEY = abcdefghijklmnopqrstuvwx")).toBe(
      "API_KEY = ***",
    );
  });

  test("имя целиком остаётся, где бы ключевое слово ни стояло", () => {
    // `[A-Z0-9_]*` после ключевого слова съедает хвост имени, а приставка
    // остаётся снаружи совпадения — маскируется ровно значение.
    expect(scrubSecretString("MY_SECRET_THING=abcdefghijklmnopqrstuvwx")).toBe(
      "MY_SECRET_THING=***",
    );
    expect(scrubSecretString("GH_APIKEY_X=abcdefghijklmnopqrstuvwx")).toBe(
      "GH_APIKEY_X=***",
    );
  });

  test("несколько присваиваний в одной строке — каждое", () => {
    const out = scrubSecretString(
      "TOKEN=aaaaaaaaaaaaaaaaaaaa PASSWORD=bbbbbbbbbbbbbbbbbbbb",
    );
    expect(out).toBe("TOKEN=*** PASSWORD=***");
  });

  test("короткое значение не трогается — это не секрет, а счётчик", () => {
    // Граница 16 символов взята из скрипта; ниже неё маскировать значит
    // ломать диагностику ради ложного срабатывания.
    expect(scrubSecretString("SESSION_COUNT=42")).toBe("SESSION_COUNT=42");
    expect(scrubSecretString("TOKEN=abc")).toBe("TOKEN=abc");
  });

  test("строчные имена не трогаются — граница та же, что у скрипта", () => {
    // Осознанная граница, а не недосмотр: скрипт ищет без -i, потому что
    // формы взяты из .env, где имена в верхнем регистре. В обычной прозе
    // «password = …» встречается куда чаще, чем в выводе программы.
    const s = "password=abcdefghijklmnopqrstuvwx";
    expect(scrubSecretString(s)).toBe(s);
  });
});

describe("ключи OpenAI с дефисом в префиксе", () => {
  const payload = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCdEfGh";

  for (const prefix of ["sk-proj-", "sk-svcacct-", "sk-admin-"]) {
    test(`${prefix} маскируется, префикс виден`, () => {
      const out = scrubSecretString(`ключ ${prefix}${payload} в тексте`);
      expect(out).toBe(`ключ ${prefix}*** в тексте`);
    });
  }

  test("прежняя форма sk- + 40 знаков по-прежнему ловится", () => {
    expect(scrubSecretString(`sk-${"A".repeat(44)}`)).toBe("sk-***");
  });

  test("голое `sk-` в обычном тексте не трогается", () => {
    // То, ради чего правило намеренно узкое: рубить лишнее в выводе чужой
    // программы значит ломать диагностику.
    const s = "флаг sk-off и слово sk-ok";
    expect(scrubSecretString(s)).toBe(s);
  });
});

describe("прежние пять форм не расшатаны", () => {
  const cases: Array<[string, string]> = [
    ["https://x-access-token:ghp_abcdefghijklmnop@github.com/x", "***@"],
    [`GITHUB_READ_TOKEN=ghp_${"b".repeat(36)}`, "ghp_***"],
    [`github_pat_${"c".repeat(40)}`, "github_pat_***"],
    [`sk-ant-api03-${"d".repeat(24)}`, "sk-ant-***"],
    ["7123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw", "7123456789:***"],
    ["Authorization: Bearer abc.def.ghi", "Bearer ***"],
    ["https://host/x?token=abcdefghijklmnop", "token=***"],
  ];
  for (const [input, want] of cases) {
    test(JSON.stringify(input.slice(0, 40)), () => {
      expect(scrubSecretString(input)).toContain(want);
    });
  }

  test("специальное правило бьёт раньше общего — префикс токена остаётся виден", () => {
    // Если бы форма ИМЯ=значение срабатывала первой, из лога исчезло бы и
    // `ghp_`, то есть тип засветившегося ключа.
    expect(scrubSecretString(`GITHUB_TOKEN=ghp_${"b".repeat(36)}`)).toBe(
      "GITHUB_TOKEN=ghp_***",
    );
  });
});

describe("паритет со скриптами-сканерами", () => {
  for (const [name, src] of SCRIPTS) {
    test(`${name} по-прежнему знает форму присваивания`, () => {
      expect(src).toContain("(TOKEN|SECRET|PASSWORD|API_KEY|APIKEY|API_HASH|SESSION)");
    });

    test(`${name}: дефисный префикс OpenAI добавлен`, () => {
      // Определений «как выглядит секрет» три: скраббер на выходной границе и
      // два гейта на входе в репозиторий. Разъехавшись, они и дают этот класс
      // дыр — поэтому правило добавляется во все три сразу.
      expect(src).toContain("sk-[a-z]{2,12}-");
    });

    test(`${name}: у каждой формы есть свой ярлык`, () => {
      // PATTERNS и LABELS индексируются одним счётчиком: разъехавшись в
      // длине, они печатают чужое имя класса или пустую строку.
      const arr = (k: string) =>
        src.split(`${k}=(`)[1]?.split("\n)")[0]?.trim().split("\n").length;
      expect(arr("PATTERNS")).toBe(arr("LABELS"));
    });
  }

  test("каждая форма скрипта маскируется скраббером", () => {
    // Круг 28: образцов было шесть при семи формах в PATTERNS, и пропущена
    // была `openai-key-prefixed` (`sk-[a-z]{2,12}-`) — та самая, ради которой
    // рядом стоит отдельный тест «дефисный префикс OpenAI добавлен». То есть
    // форму в скраббер добавили, а в перечисление образцов — нет, и общий
    // счёт «шесть» это расхождение закреплял.
    //
    // Круг 51: и сам счёт оказался тем же классом дефекта. В имени теста
    // стояло «все семь форм», в PATTERNS появилась восьмая
    // (`telegram-string-session`) — и имя стало врать ровно так же, как врал
    // счёт образцов. Числа здесь больше нет: длину берём у PATTERNS.
    const samples = [
      "7123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw",
      `sk-ant-${"d".repeat(24)}`,
      `sk-${"A".repeat(44)}`,
      `sk-proj-${"e".repeat(24)}`,
      `ghp_${"b".repeat(36)}`,
      `github_pat_${"c".repeat(40)}`,
      `SESSION=${SESSION}`,
      SESSION_BARE,
    ];
    for (const s of samples) expect(scrubSecretString(s)).toContain("***");

    // Сверка с источником: столько же форм, сколько их в скрипте. Разъедется
    // — упадёт здесь, а не молча через полгода на восьмой утечке.
    for (const [name, src] of SCRIPTS) {
      const n = src.split("PATTERNS=(")[1]?.split("\n)")[0]?.trim().split("\n").length;
      expect(`${name}: ${samples.length}`).toBe(`${name}: ${n}`);
    }
  });
});
