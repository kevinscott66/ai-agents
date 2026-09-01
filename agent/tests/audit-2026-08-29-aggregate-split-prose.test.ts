/**
 * Аудит 2026-08-29: `categorizeAggregateError` считала склейкой любую строку
 * с `"; "` внутри.
 *
 * Разбор по сегментам добавили 2026-08-28 для склеек SPLIT_TASK, и он верен.
 * Но вход выбирался так: `(m ? m[1]! : s).split("; ")`. Обёртку («split failed:
 * no roles accepted the task (…)») проверяли только чтобы снять скобки, а
 * ветка `: s` резала по `"; "` вообще всё. Докблок при этом обещал обратное:
 * «Одиночная строка проходит в categorizeError без изменений: у неё сегментов
 * нет».
 *
 * Сегментов у неё нет, а точка с запятой — есть. И у прозы, разрезанной
 * пополам, вторая половина обычно не ошибка вовсе: в приоритетах `unknown`
 * стоит ВЫШЕ `rate_limited` (осознанно — для настоящих склеек), поэтому
 * бессмысленный хвост побеждал осмысленное начало.
 *
 * Живых производителей таких строк двое, оба возвращают `{ok:false, error}` из
 * `dispatchAction`, откуда `res.error` идёт прямо в `createDiagnosticTask`:
 * отмена публикации с удалением осиротевшего баннера (`dispatch/publish.ts`) и
 * провал GENERATE_IMAGE вместе с svg-фолбэком (`dispatch/media.ts`).
 */
import { describe, expect, test } from "bun:test";
import {
  categorizeAggregateError,
  categorizeError,
  pickResponsibleRole,
} from "../lib/diagnostic.ts";

const split = (...segs: string[]) =>
  `split failed: no roles accepted the task (${segs.join("; ")})`;

// Дословно из dispatch/publish.ts: текст не ушёл, баннер прибран.
const PUBLISH_429 =
  "публикация отменена: текст не ушёл (429: Too Many Requests: retry after 30); баннер удалён, канал чист";
// Дословно из dispatch/media.ts: обе попытки картинки провалились.
const IMAGE_BOTH =
  "GENERATE_IMAGE failed (429: Too Many Requests); svg-fallback also failed: quota exceeded";

describe("проза с точкой с запятой — не склейка", () => {
  test("отмена публикации по лимиту остаётся лимитом", () => {
    // Вторая половина («баннер удалён, канал чист») — не ошибка, а отчёт об
    // уборке. Как «сегмент» она даёт unknown и перебивает 429 из первой.
    expect(categorizeAggregateError(PUBLISH_429)).toBe("rate_limited");
    expect(categorizeAggregateError(PUBLISH_429)).toBe(categorizeError(PUBLISH_429));
  });

  test("лимит не заводит задачу на доске", () => {
    // Цена регрессии именно здесь: unknown -> orchestrator -> «[diagnostic]
    // unknown: PUBLISH_TO_CHANNEL … Manual triage» на доске владельца после
    // обычного троттлинга Telegram. rate_limited -> null, задачи нет.
    expect(pickResponsibleRole(categorizeAggregateError(PUBLISH_429))).toBeNull();
  });

  test("двойной провал картинки читается по всей строке", () => {
    expect(categorizeAggregateError(IMAGE_BOTH)).toBe(categorizeError(IMAGE_BOTH));
  });

  test("двоеточие в прозе не делает сегмент ролью", () => {
    const s = "не удалось: причина одна; и ещё: причина два";
    expect(categorizeAggregateError(s)).toBe(categorizeError(s));
  });
});

describe("настоящие склейки разбираются как раньше", () => {
  test("обёрнутая склейка — по сегментам", () => {
    expect(
      categorizeAggregateError(split("backend: 429 rate limit", "aieng: unknown action FOO")),
    ).toBe("missing_capability");
  });

  test("склейка без обёртки опознаётся по форме сегментов", () => {
    // Сегменты собирает `joinDelegationErrors` как `role: причина`. Без обёртки
    // такой набор до categorizeAggregateError сегодня не доходит, но докблок
    // модуля называет фан-аут вторым источником склеек — эту способность
    // сохраняем, сужается только вход.
    expect(
      categorizeAggregateError("backend: 429 rate limit; aieng: unknown action FOO"),
    ).toBe("missing_capability");
  });

  test("одиночный сегмент по-прежнему читается целиком", () => {
    const s = split("backend: 429 rate limit");
    expect(categorizeAggregateError(s)).toBe(categorizeError(s));
  });
});
