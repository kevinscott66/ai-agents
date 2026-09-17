/**
 * Регистрация admin-команд Lead-бота (orchestrator):
 *   /approve, /reject, /tasks, /autonomy, /discussion, /grant, /revoke, /perms, /audit, /approvals.
 *
 * Каждая команда описана как `{ name, handler }`. `registerAdminCommands`
 * подключает их к Telegraf-инстансу одним вызовом.
 */
import type { Telegraf, Context } from "telegraf";
import {
  cmdApprove,
  cmdReject,
  cmdTasks,
  cmdAutonomy,
  cmdDiscussion,
  cmdGrant,
  cmdRevoke,
  cmdPerms,
  cmdAudit,
  cmdApprovals,
  isAutonomyMode,
  type ApprovalExecDeps,
} from "./commands.ts";
import { isAllowlisted, parseUserIdList } from "./allowlist.ts";
import { sendChunked } from "./telegram-chunking.ts";
import { log } from "./log.ts";

/**
 * Numeric admin user-ids allowed to run Lead-bot admin commands.
 * Prefers TELEGRAM_ADMIN_USER_IDS, falls back to the Mini App admin set.
 *
 * Аудит 2026-08-12, две правки на одной строке:
 *
 * 1. Фолбэк стоял на `??`, который срабатывает только на undefined. Строка
 *    `TELEGRAM_ADMIN_USER_IDS=` в .env (и в systemd EnvironmentFile) даёт
 *    ПУСТУЮ строку, а не undefined — то есть ровно в конфигурации из
 *    .env.example фолбэк не работал, список админов оказывался пуст, и
 *    владелец на /approve получал «⛔ только для администраторов».
 *
 * 2. `parseInt` разбирает префикс: `parseInt("12345x678")` = 12345. Опечатка в
 *    CSV не отбрасывалась, а становилась ДРУГИМ валидным id — на границе,
 *    которая решает, кто одобряет рискованные действия и раздаёт права. Mini
 *    App тот же список читает через `Number()` + `n > 0`, то есть один .env
 *    давал два разных набора админов. Разбор теперь общий (parseUserIdList в
 *    lib/allowlist.ts), инвариант закреплён тестом.
 *
 * Круг 42, чтобы пункт 2 не читался шире, чем он есть: общей стала ФОРМА
 * разбора, а не состав. Наборы расходятся, как только TELEGRAM_ADMIN_USER_IDS
 * непуста — её читает только эта функция, а Mini App берёт исключительно
 * MINIAPP_ADMIN_USER_IDS (`parseAdminIds` в miniapp-server.ts), и фолбэка в
 * обратную сторону там нет. Так и задумано: админ Lead-бота и админ Mini App
 * совпадать не обязаны. Но переход между «один админ на оба входа» и «два
 * разных списка» делается молча, одной строкой в .env, и на этом различии
 * стоит, в частности, кто дотянется до POST /api/mac/stop.
 */
export function parseAdminUserIds(): number[] {
  const tg = process.env.TELEGRAM_ADMIN_USER_IDS?.trim();
  const raw = tg ? tg : process.env.MINIAPP_ADMIN_USER_IDS;
  return parseUserIdList(raw);
}

/**
 * SECURITY (T-600): admin commands (/approve, /grant, /autonomy, …) must only
 * run for a known admin numeric user-id. Without this, any member of an
 * allowlisted group — or anyone who DMs the bot — could approve risky actions,
 * grant permissions, or flip autonomy to `auto`. Fail-closed: empty admin list
 * denies everyone (display names are NOT trusted — only ctx.from.id).
 */
export function isAuthorizedAdmin(ctx: Context): boolean {
  const ids = parseAdminUserIds();
  const fromId = ctx.from?.id;
  return ids.length > 0 && typeof fromId === "number" && ids.includes(fromId);
}

export interface AdminCmdCtx {
  chatId: number;
  decidedBy: string;
  /** Резолверы для исполнения одобренного действия (см. ApprovalExecDeps). */
  deps: ApprovalExecDeps;
}

export const ADMIN_COMMANDS: Array<{
  name: string;
  handler: (args: string[], ctx: AdminCmdCtx) => string | Promise<string>;
}> = [
  {
    name: "approve",
    handler: async (args, ctx) => {
      const id = args[0];
      if (!id) return "Usage: /approve <approvalId>";
      return cmdApprove({
        approvalId: id,
        decidedBy: ctx.decidedBy,
        chatId: ctx.chatId,
        deps: ctx.deps,
      });
    },
  },
  {
    name: "reject",
    handler: (args, ctx) => {
      const id = args[0];
      if (!id) return "Usage: /reject <approvalId> [reason...]";
      const reason = args.slice(1).join(" ") || undefined;
      return cmdReject({
        approvalId: id,
        decidedBy: ctx.decidedBy,
        chatId: ctx.chatId,
        reason,
      });
    },
  },
  {
    name: "tasks",
    // Аудит 2026-08-27: аргументы глотались, а `cmdTasks` фильтр по роли
    // умеет. `/tasks smm` показывал весь чат под ролевым заголовком.
    handler: (args, ctx) =>
      cmdTasks({ chatId: ctx.chatId, agentKey: args[0] }),
  },
  {
    name: "autonomy",
    handler: (args, ctx) => {
      const modeArg = args[0];
      if (modeArg && !isAutonomyMode(modeArg)) {
        return `Unknown mode: ${modeArg}. Use: locked|manual|semi_auto|auto`;
      }
      return cmdAutonomy({
        chatId: ctx.chatId,
        mode: modeArg && isAutonomyMode(modeArg) ? modeArg : undefined,
      });
    },
  },
  {
    name: "discussion",
    handler: (args, ctx) => {
      const a = (args[0] ?? "").toLowerCase();
      const on =
        a === "on" || a === "вкл"
          ? true
          : a === "off" || a === "выкл"
            ? false
            : undefined;
      if (args[0] && on === undefined) {
        return "Usage: /discussion [on|off]";
      }
      return cmdDiscussion({ chatId: ctx.chatId, on });
    },
  },
  {
    name: "grant",
    handler: (args, ctx) =>
      cmdGrant({ args, changedBy: ctx.decidedBy, chatId: ctx.chatId }),
  },
  {
    name: "revoke",
    handler: (args, ctx) =>
      cmdRevoke({ args, changedBy: ctx.decidedBy, chatId: ctx.chatId }),
  },
  { name: "perms", handler: (args) => cmdPerms({ args }) },
  { name: "audit", handler: (args) => cmdAudit({ args }) },
  {
    name: "approvals",
    handler: (args, ctx) => cmdApprovals({ chatId: ctx.chatId, args }),
  },
];

/**
 * Кто принял решение — для approvals.decided_by и журнала.
 *
 * Аудит 2026-08-09: здесь возвращался `username ?? first_name ?? tg:<id>`.
 * Строкой ПЕРВОГО выбора было то, что человек назначает себе сам и меняет в
 * пару касаний, а вторым — first_name, который вообще не уникален. И это в
 * поле, которое отвечает на вопрос «кто одобрил выполнение рискованного
 * действия». Двумя строками выше авторизация делается правильно — по
 * telegram id (isAuthorizedAdmin), так что стабильный идентификатор был под
 * рукой; в след уходил не он. Mini App на том же событии пишет
 * `miniapp:<user.id>` — id-based, как и надо.
 *
 * Теперь id идёт первым и всегда: `tg:<id>`. Человекочитаемая часть остаётся
 * припиской — она полезна тому, кто читает журнал, но не является личностью.
 */
function deciderIdentity(ctx: Context): string {
  const id = ctx.from?.id;
  if (id === undefined) return "tg:unknown";
  const label = ctx.from?.username
    ? `@${ctx.from.username}`
    : (ctx.from?.first_name ?? "");
  return label ? `tg:${id} (${label})` : `tg:${id}`;
}

/**
 * Аргументы команды из текста сообщения — без имени команды.
 *
 * Аудит 2026-08-28: `filter(Boolean)` здесь не косметика. Двойные пробелы
 * внутри строки `\s+` съедает сам, а хвостовой — нет: `"/audit ".split(/\s+/)`
 * даёт `["/audit", ""]`, и пустая строка уезжала в аргументы как значение.
 * Команды, проверяющие аргумент на истинность, её не замечали, а две — вполне:
 * `/audit·` отвечал «Неизвестный agent: .», `/grant qa SET_REACTION·` —
 * «Неизвестный mode: .». Оба — отказ на команду, набранную правильно, с
 * причиной, которой человек не вводил; хвостовой пробел ставят мобильные
 * клавиатуры сами.
 *
 * Чиним здесь, а не в двух хендлерах: аргумента, которого человек не писал, не
 * должно быть ни у кого — включая команды, добавленные завтра.
 */
export function parseCommandArgs(text: string): string[] {
  return text.split(/\s+/).slice(1).filter(Boolean);
}

export function registerAdminCommands(
  bot: Telegraf,
  deps: ApprovalExecDeps,
  allowed: string[],
) {
  for (const c of ADMIN_COMMANDS) {
    bot.command(c.name, async (telegrafCtx) => {
      // Аудит 2026-08-09: allowlist чата действовал на двух входах из трёх.
      // message-handler и voice-handler фильтруют чат, а команды регистрируются
      // на том же боте и не фильтровали ничего — telegraf отдаёт `/команду`
      // боту даже под privacy mode и не пускает апдейт дальше в bot.on("message").
      // Отсюда две беды: (1) любой посторонний, затащивший бота в свой чат, мог
      // получить от него ответ («⛔ только для админов») вне allowlist — это уже
      // нарушение обещания «бот не разговаривает вне разрешённых чатов» плюс
      // подсказка, что тут есть админ-поверхность; (2) админ, набравший
      // /autonomy или /discussion в личке, писал настройки на scope того чата,
      // который message-handler всё равно никогда не прочитает — а ответ
      // выглядел как успех. Ставим ту же fail-closed проверку, что у соседей.
      const chatIdStr = String(telegrafCtx.chat?.id ?? "");
      if (!isAllowlisted(chatIdStr, allowed)) {
        log.info(
          `[admin-cmd] chat ${chatIdStr} not in allowlist — команда ${c.name} проигнорирована`,
        );
        return;
      }
      if (!isAuthorizedAdmin(telegrafCtx)) {
        log.warn("admin command denied — sender is not an admin", {
          cmd: c.name,
          fromId: telegrafCtx.from?.id,
          chatId: telegrafCtx.chat?.id,
        });
        await telegrafCtx.reply("⛔ Эта команда доступна только администраторам.");
        return;
      }
      const msg: any = telegrafCtx.message;
      const text: string = msg?.text ?? "";
      const args = parseCommandArgs(text);
      const reply = await c.handler(args, {
        chatId: telegrafCtx.chat.id,
        decidedBy: deciderIdentity(telegrafCtx),
        deps,
      });
      // Аудит 2026-08-13: тут стоял голый `reply(reply)`, а лимит сообщения в
      // Telegram — 4096 символов. `/audit 100` даёт до сотни строк примерно по
      // 60 символов, `/approvals` — по строке на approval с выжимкой payload:
      // обе легко переваливают за лимит. Ответ длиннее лимита — это 400 от
      // Telegram, то есть throw из хендлера, а он до bot-error-guard.ts ронял
      // весь поллинг бота. Режем тем же sendChunked, что и обычные ответы.
      await sendChunked((t) => telegrafCtx.reply(t), reply);
    });
  }
}
