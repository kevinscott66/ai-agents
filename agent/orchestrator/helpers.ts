/**
 * T-320: Shared pure helpers extracted from orchestrator-team.ts.
 *
 * These were previously defined (and exported) directly in orchestrator-team.ts.
 * They are moved here so both orchestrator-team.ts (re-export, for backward
 * compat with tests/t322-orchestrator-team.test.ts) and the extracted
 * ./message-handler.ts can import them without a load-time circular dependency
 * (orchestrator-team → message-handler → orchestrator-team).
 */
import { type Context } from "telegraf";
import { log } from "../lib/log.ts";

/**
 * Разбор `MEMORY_HISTORY_LIMIT` — сколько сообщений истории поднимать в ответ.
 *
 * Аудит 2026-08-21: раньше было `Number(process.env.X ?? DEFAULT)`. `??` ловит
 * только null/undefined, а объявленная и пустая переменная — это `""`, до
 * дефолта дело не доходило: `Number("")` равен 0. Отдавал её сам репозиторий —
 * `.env.example` печатает `MEMORY_HISTORY_LIMIT=` без значения, то есть
 * документированный путь настройки выключал у оркестратора память о разговоре.
 * Замер: пять сообщений в базе, `LIMIT 0`, ноль строк истории.
 *
 * Ноль опаснее падения: SQLite его принимает, агент отвечает без контекста и
 * выглядит поглупевшим, а не сломанным. Мусор, наоборот, ронял каждое
 * сообщение — NaN уходил биндом прямо в `LIMIT`.
 *
 * Поэтому: пусто (или пробелы) — это «не задано», молча берём дефолт. Всё
 * остальное негодное (не число, ноль, отрицательное) — тоже дефолт, но уже с
 * предупреждением: тут человек что-то ввёл и должен узнать, что это не
 * применилось.
 */
export function parseHistoryLimit(raw: string | undefined, dflt: number): number {
  const v = (raw ?? "").trim();
  if (v === "") return dflt;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 1) {
    log.warn("[env] MEMORY_HISTORY_LIMIT негоден — берём значение по умолчанию", {
      raw,
      fallback: dflt,
    });
    return dflt;
  }
  return Math.floor(n);
}

/** Keep only the last `n` lines of a multi-line string. */
export function tailLines(s: string, n: number): string {
  const lines = s.split("\n");
  return lines.slice(-n).join("\n");
}

/**
 * Хэндлы (`@name`, нижний регистр), которые сам Telegram разметил сущностью
 * `mention`.
 *
 * Различается ровно одно: есть сообщение или нет. `undefined` — «сообщения
 * нет, судить не по чему» (тогда вызывающий вправе упасть на запасной путь).
 * Пустой массив — «в этом сообщении нас не звали», и он НЕ означает, что
 * разметка пришла: `entities` могло не быть вовсе (обычный текст без
 * форматирования), быть пустым, или нести только не-`mention` сущности.
 * Отличить эти случаи по возврату нельзя и не нужно — оба вызывающих спрашивают
 * «упомянут ли», а не «размечено ли».
 *
 * Это единственный источник правды об упоминаниях: по нему решается и
 * доставка сообщения роли (`isMentioned`), и снятие инструментов у Lead
 * (`shouldAllowTools`). Пока их было два, они расходились — см. аудит
 * 2026-08-28.
 */
export function mentionedHandles(ctx: Context): string[] | undefined {
  const msg: any = ctx.message;
  if (!msg) return undefined;
  const entities = msg.entities ?? msg.caption_entities ?? [];
  const text: string = msg.text ?? msg.caption ?? "";
  const out: string[] = [];
  for (const ent of entities) {
    if (ent.type === "mention") {
      out.push(text.slice(ent.offset, ent.offset + ent.length).toLowerCase());
    }
  }
  return out;
}

/** True if the message text @-mentions the given bot username. */
export function isMentioned(ctx: Context, username: string): boolean {
  if (!username) return false;
  return (mentionedHandles(ctx) ?? []).includes(`@${username.toLowerCase()}`);
}
