/**
 * Аудит 2026-09-11, круг 51: секреты доезжали до диска, потому что чистили их
 * у вызывающих, а не на границе записи.
 *
 * `scrubSecretString` стоял на выходной границе ЛОГА. В `agent_actions` же
 * писали напрямую: `insertActionRow`, `finalizeActionRow`,
 * `closeGatedActionRow` клали `payload`/`result`/`error` как есть. Каждое
 * место, откуда приходила строка с секретом, приходилось чинить отдельно — и
 * три таких места нашлись (lib/dispatch/telegram.ts дважды и
 * lib/telegram-chunking.ts), а четвёртое написал бы следующий. Колонка при
 * этом не внутренняя: `/api/actions` отдаёт её админам Mini App, GET_LOGS —
 * самой модели.
 *
 * Починка поэтому не в вызывающих, а в одной точке: чистит тот, кто пишет.
 * Ниже — доказательство по поведению, а не по тексту: строка с секретом
 * кладётся через публичный API аудита и вычитывается из БД обратно.
 *
 * Вторая половина файла — три формы секрета, которых скраббер не знал:
 *   • `TELEGRAM_API_HASH=` — присваивание с именем, которого не было в
 *     перечислении ключевых слов, хотя api_hash это половина входа в аккаунт
 *     юзербота (вторая половина — телефон);
 *   • StringSession gramjs БЕЗ имени рядом. Форма `ИМЯ=значение` ловит её
 *     только в `.env`-виде; в JSON-дампе и в тексте исключения она идёт голой;
 *   • camelCase-ярлык (`accessToken: …`). Прежнее правило требовало границы
 *     слова перед ключевым словом, а в `accessToken` перед `Token` стоит
 *     буква — то есть весь camelCase, то есть весь наш же TypeScript.
 */
import { describe, test, expect } from "bun:test";
import { scrubSecretString } from "../lib/log.ts";
import { insertActionRow, finalizeActionRow, closeGatedActionRow } from "../lib/audit.ts";
import { db } from "../lib/db.ts";

/** Похоже на настоящий бот-токен: 10 цифр, двоеточие, 35 знаков. */
const BOT_TOKEN = "7123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw";
/** StringSession gramjs: `1` + сотни знаков base64. */
const STRING_SESSION = `1B${"QaZwSx0129".repeat(30)}`;

function readRow(id: string): { payload: string | null; result: string | null; error: string | null } {
  return db
    .prepare("SELECT payload, result, error FROM agent_actions WHERE id=?")
    .get(id) as { payload: string | null; result: string | null; error: string | null };
}

describe("в agent_actions секрет не доезжает ни по одному из трёх путей", () => {
  test("insertActionRow чистит error, payload и result", () => {
    const { id } = insertActionRow("SEND_MESSAGE", {
      agentKey: "smm",
      status: "error",
      payload: { url: `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage` },
      result: { note: `TELEGRAM_SESSION=${STRING_SESSION}` },
      error: `fetch failed: https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
    });
    const row = readRow(id);
    for (const cell of [row.payload, row.result, row.error]) {
      expect(cell).not.toContain(BOT_TOKEN);
      expect(cell).not.toContain(STRING_SESSION);
      expect(cell).toContain("***");
    }
    // Диагностика не выброшена вместе с секретом: понятно, что это за ключ и
    // куда шёл запрос. Ради этого правила и узкие — маскируется значение.
    expect(row.error).toContain("api.telegram.org");
    expect(row.error).toContain("7123456789:");
  });

  test("finalizeActionRow чистит то же самое при закрытии строки", () => {
    const { id } = insertActionRow("SEND_MESSAGE", {
      agentKey: "smm",
      status: "attempted",
    });
    finalizeActionRow(id, {
      status: "error",
      result: { echo: `ANTHROPIC_API_KEY=sk-ant-api03-${"d".repeat(24)}` },
      error: `401 from https://api.telegram.org/bot${BOT_TOKEN}/getMe`,
    });
    const row = readRow(id);
    expect(row.error).not.toContain(BOT_TOKEN);
    expect(row.result).not.toContain("sk-ant-api03-dddd");
    expect(row.result).toContain("***");
  });

  test("closeGatedActionRow чистит ДО обрезки, а не после", () => {
    // Каверза, ради которой скраб стоит первым: обрезанный секрет перестаёт
    // совпадать с правилом, и в базу уезжает его начало нетронутым. Хвост
    // добит до длины, на которой обрезка (2000) режет прямо по токену.
    const tail = `tail ${BOT_TOKEN}`;
    const { id } = insertActionRow("SEND_MESSAGE", {
      agentKey: "smm",
      status: "pending_approval",
    });
    closeGatedActionRow(id, "x".repeat(2000 - tail.length + 10) + tail);
    const row = readRow(id);
    expect(row.error).not.toContain("AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw");
    expect(row.error!.length).toBeLessThanOrEqual(2000);
  });

  test("пустой error остаётся NULL, а не строкой «null»", () => {
    // Читающая сторона (`/api/actions`, GET_LOGS) отличает «ошибки не было» от
    // «ошибка пустая» по NULL. Обёртка не смеет это ломать.
    const { id } = insertActionRow("SEND_MESSAGE", { agentKey: "smm", status: "ok" });
    expect(readRow(id).error).toBeNull();
  });
});

describe("формы секретов, которых скраббер не знал", () => {
  test("api_hash в верхнем регистре маскируется как остальные присваивания", () => {
    const hash = "0123456789abcdef0123456789abcdef";
    expect(scrubSecretString(`TELEGRAM_API_HASH=${hash}`)).toBe("TELEGRAM_API_HASH=***");
  });

  test("StringSession маскируется без имени рядом — по одной только форме", () => {
    expect(scrubSecretString(STRING_SESSION)).toBe("***");
    expect(scrubSecretString(`session: ${STRING_SESSION}`)).toBe("session: ***");
  });

  test("обычный base64 короче порога не трогается", () => {
    // Порог в 250 знаков — не украшение: логи полны base64 покороче (подписи,
    // хэши, куски json), и рубить их значит ослепить диагностику.
    const benign = `1A${"QaZwSx0129".repeat(10)}`;
    expect(benign.length).toBeLessThan(250);
    expect(scrubSecretString(benign)).toBe(benign);
  });

  test("camelCase-ярлык маскирует значение и оставляет имя", () => {
    expect(scrubSecretString('accessToken: "abc123def456ghi789"')).toBe(
      'accessToken: "***"',
    );
    expect(scrubSecretString("{ userToken: 'zzzzzzzzzzzzzzzz' }")).toBe(
      "{ userToken: '***' }",
    );
  });

  test("ключевое слово без значения — это проза, её не трогаем", () => {
    // Правило требует разделитель `:` — иначе оно съедало бы каждое
    // предложение, где слово `token` стоит рядом с чем угодно.
    const s = "Broken: the accessToken was rejected";
    expect(scrubSecretString(s)).toBe(s);
  });
});
