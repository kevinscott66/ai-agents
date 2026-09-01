/**
 * Handlers for team-channel lifecycle actions.
 *
 * Extracted from action-dispatch.ts as a mechanical T-610 refactoring slice.
 * The userbot resolver stays injected so routing and test seams remain owned
 * by the dispatch boundary.
 */
import { getErrorMessage } from "../errors.ts";
import { log } from "../log.ts";
import { registerTeamChannel } from "../team-channels.ts";
import { guardedUserbotCall, noteFloodWait } from "../userbot-flood.ts";
import type { UserbotHandle } from "../userbot.ts";
import type { RunningBot } from "../types.ts";
import type { PayloadByType } from "../action-payload.ts";
import type { HandlerResult } from "./helpers.ts";

export interface ChannelHandlerContext {
  agentKey: string;
  chatId: number;
  resolveAgent?: (role: string) => RunningBot | undefined;
  resolveUserbot: () => Promise<UserbotHandle | null>;
}

export type ChannelHandlerResult = HandlerResult;

export async function handleCreateTeamChannel(
  payload: PayloadByType["CREATE_TEAM_CHANNEL"],
  ctx: ChannelHandlerContext,
): Promise<ChannelHandlerResult> {
  const ub = await ctx.resolveUserbot();
  if (!ub || ub.isNoop) {
    return { ok: false, error: "userbot недоступен — канал не создать" };
  }

  // Резолвим роли → @username их ботов через запущенные боты. Контролёра
  // (orchestrator) добавляем всегда — он проверяет тексты/превью.
  const wantRoles = Array.from(new Set([...(payload.roles ?? []), "orchestrator"]));
  const usernames: string[] = [];
  // Аудит 2026-08-27: нерезолвнутые роли молча исчезали. Роль не попадала ни в
  // `result.added`, ни в `result.failed` — оба списка приходят от userbot'а и
  // знают только про переданные @username. Канал создавался, действие
  // рапортовало `ok:true` с полным `added`, и никто — ни модель, ни человек —
  // не узнавал, что backend в канал не приглашён. Хуже: комментарий строкой
  // выше обещает «контролёра добавляем всегда», а если не резолвился именно
  // orchestrator, канал уезжал БЕЗ проверяющего, тихо.
  const unresolved: string[] = [];
  for (const role of wantRoles) {
    const bot = ctx.resolveAgent?.(role);
    const username = bot?.username?.replace(/^@/, "");
    if (username) usernames.push(username);
    else unresolved.push(role);
  }
  if (!usernames.length) {
    return { ok: false, error: "не удалось резолвить ботов ролей (resolveAgent пуст)" };
  }
  if (unresolved.includes("orchestrator")) {
    // Канал неидемпотентен: создать и потом «дорезолвить» контролёра нельзя,
    // придётся сносить руками. Дешевле отказать до создания.
    return {
      ok: false,
      error:
        "orchestrator не резолвится (бот не запущен?) — канал без контролёра " +
        `не создаю; не резолвятся: ${unresolved.join(", ")}`,
    };
  }

  // Аудит 2026-08-28: раньше один `try` накрывал и создание, и всё, что идёт
  // после него, — а общий `catch` возвращал голое `{ ok: false }`. Бросок
  // регистрации (это INSERT в SQLite) означал, что канал в аккаунте владельца
  // уже есть, а действие отчитывалось как «не случилось ничего»: слот
  // рейт-лимита рефандился (gateOrDispatch смотрит на `sideEffect`), а модель
  // читала «не получилось» и повторяла — создавая второй канал.
  //
  // Поэтому две разные зоны с разной семантикой провала.
  let result: Awaited<ReturnType<UserbotHandle["createTeamChannel"]>>;
  try {
    // maxFloodRetries: 0 намерен: CreateChannel неидемпотентен, поэтому
    // повтор после FLOOD_WAIT мог бы создать второй канал.
    result = await guardedUserbotCall(
      ctx.agentKey,
      ctx.chatId,
      () => ub.createTeamChannel(payload.title, payload.about ?? "", usernames),
      { maxFloodRetries: 0 },
    );
  } catch (error) {
    // Канала нет — до CreateChannel бросать нечему, а после него
    // createTeamChannel ошибки ловит сам. Обычный провал, повтор безопасен.
    return { ok: false, error: getErrorMessage(error) };
  }

  try {
    // Регистрируем канал → PUBLISH_TO_CHANNEL сможет в него постить.
    registerTeamChannel(result.channelId, result.title, ctx.chatId);
    if (result.floodWaitSeconds !== undefined) {
      // Канал создан, но часть ботов админами не стала. Этот FLOOD_WAIT
      // происходит внутри цикла приглашений, поэтому взводим гвард вручную.
      noteFloodWait(ctx.agentKey, result.floodWaitSeconds);
      log.error("[create-channel] FLOOD_WAIT — админы добавлены не все", {
        channelId: result.channelId,
        added: result.added,
        failed: result.failed,
        seconds: result.floodWaitSeconds,
      });
    }
    log.info("[create-channel] создан", {
      channelId: result.channelId,
      added: result.added,
      failed: result.failed,
      unresolved,
    });
    // Аудит 2026-08-28: note собиралась ровно из одного сигнала — unresolved.
    // Сигналов о неполном составе три, и два оставались молчаливыми: `failed`
    // (бот резолвнулся, но Telegram отказал в правах — постить он не сможет) и
    // `floodWaitSeconds` (цикл приглашений оборван на середине, остаток команды
    // не приглашён вовсе; про него есть только log.error, которого модель не
    // видит). Оба уезжали сырыми полями result — а вывод соседнего аудита
    // 2026-08-27 в этой же функции ровно про то, что сырого списка мало.
    //
    // Отказом это не делаем: канал создан и неидемпотентен, ok:false заставит
    // модель повторить и завести второй. `ok:true` здесь значит «канал есть»,
    // а не «состав полный» — вот это и надо сказать словами.
    const problems: string[] = [];
    if (unresolved.length) {
      problems.push(`роли без запущенного бота в канал не приглашены: ${unresolved.join(", ")}`);
    }
    if (result.failed?.length) {
      problems.push(`Telegram не дал прав админа: ${result.failed.join(", ")}`);
    }
    if (result.floodWaitSeconds !== undefined) {
      problems.push(
        `Telegram потребовал паузу ${result.floodWaitSeconds}s — приглашения оборваны на середине`,
      );
    }
    if (problems.length) {
      return {
        ok: true,
        result: {
          ...result,
          ...(unresolved.length ? { unresolved } : {}),
          note:
            `${problems.join("; ")} — постить в канал они не смогут; ` +
            "скажи человеку, не выдавай состав канала за полный",
        },
      };
    }
    return { ok: true, result };
  } catch (error) {
    const message = getErrorMessage(error);
    log.error("[create-channel] канал создан, но шаг после создания упал", {
      channelId: result.channelId,
      error: message,
    });
    return {
      ok: false,
      // Слот не рефандить: ход уже оставил канал в аккаунте владельца.
      sideEffect: true,
      error:
        `канал ${result.channelId} создан в Telegram, но шаг после создания упал: ${message}. ` +
        "Не создавай второй — постить в него всё равно нельзя (в реестр он не попал); " +
        "скажи человеку: канал надо удалить руками",
    };
  }
}
