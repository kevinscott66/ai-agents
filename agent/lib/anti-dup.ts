/**
 * C7: anti-duplication эвристика для Lead-агента.
 *
 * Симптом: пользователь обращается к конкретному агенту («@design …»),
 * Lead подхватывает реплай (как default-роутер) и зеркалит действие
 * (например, повторно вызывает CREATE_POLL). Хотим: если в недавнем
 * контексте видно, что разговор адресован другому агенту, Lead отвечает
 * только текстом, без инструментов.
 *
 * Эвристика грубая (последние N сообщений) — может срабатывать и в
 * полезных кейсах; это сознательный trade-off на старте.
 */
import type { ChatRow } from "./db.ts";
import type { RunningBot } from "./types.ts";
import type { CharacterDef } from "../characters/index.ts";


/**
 * Возвращает true, если агенту разрешено использовать инструменты в
 * этом ответе. Для не-Lead агентов всегда true. Для Lead — false, если
 * текущее сообщение @-адресовано другому нашему боту.
 *
 * `mentions` — хэндлы, размеченные самим Telegram (см. `mentionedHandles`).
 * Если они переданы, судим только по ним: ровно по этой разметке решается и
 * доставка сообщения роли, поэтому расходиться с ней нельзя. `undefined`
 * (сообщения нет — тесты, внутренние вызовы) включает запасной поиск по
 * тексту.
 */
export function shouldAllowTools(
  def: Pick<CharacterDef, "key">,
  _recent: ChatRow[],
  text: string,
  bots: RunningBot[],
  mentions?: readonly string[],
): boolean {
  if (def.key !== "orchestrator") return true;

  const otherBotUsernames = bots
    .filter((b) => b.def.key !== "orchestrator")
    .map((b) => b.username.toLowerCase())
    .filter(Boolean);

  // Автономность-фикс (2026-06-10): отключаем инструменты Lead'а ТОЛЬКО когда
  // ТЕКУЩЕЕ сообщение пользователя явно @-адресовано другому боту — тогда тот
  // сам ответит, и Lead не зеркалит. РАНЬШЕ отключали ещё и при ЛЮБОМ недавнем
  // сообщении/упоминании другого бота в истории (LOOKBACK) — но в активном
  // командном чате это почти всегда истина, из-за чего оркестратор после ответа
  // коллеги НЕ мог делегировать дальше и автономный пайплайн вставал.
  const lowerText = (text ?? "").toLowerCase();
  const marked = mentions?.map((m) => m.toLowerCase());
  const mentioned = (handle: string): boolean =>
    marked ? marked.includes(`@${handle}`) : mentionsHandle(lowerText, handle);

  // Аудит 2026-08-20: свой собственный хэндл раньше не проверялся вовсе,
  // поэтому «@lead собери релиз: баннер от @design» глушил инструменты
  // именно у того, кого прямым текстом попросили координировать. Правило
  // про «обращаются НЕ к нему» не должно срабатывать на «к нему в том числе».
  const selfUsername = bots
    .find((b) => b.def.key === def.key)
    ?.username?.toLowerCase();
  if (selfUsername && mentioned(selfUsername)) return true;

  // Аудит 2026-08-27: здесь стоял голый `includes("@" + u)`, тогда как своё
  // упоминание выше проверялось с границей слова. Из-за асимметрии
  // посторонний хэндл-префикс (`@dlb_design_bot_v2`, чужой бот с похожим
  // именем) считался упоминанием нашего `@dlb_design_bot` и молча выключал
  // инструменты оркестратора — ровно та ложная сработка, ради которой
  // границу и завели.
  //
  // Уточнение 2026-08-28: в проде эта ложная сработка сегодня недостижима, и
  // сценарий выше описывает прошлое, а не текущий риск. Единственный
  // вызывающий (message-handler.ts:710) всегда передаёт `mentions`, а
  // `mentionedHandles` отдаёт undefined только при отсутствии `ctx.message`,
  // чего в обработчике сообщения не бывает — значит `mentioned` идёт по
  // разметке Telegram, а `mentionsHandle` остаётся путём тестов и внутренних
  // вызовов. Границы в нём не снимай: разметки нет как раз там, где текст
  // собран нами, и ошибиться дешевле всего.
  for (const u of otherBotUsernames) {
    if (mentioned(u)) return false;
  }
  return true;
}

/**
 * Запасной путь: `@name` как САМОСТОЯТЕЛЬНЫЙ хэндл. Соседний символ с любой
 * стороны не может быть частью username (Telegram допускает только
 * `[A-Za-z0-9_]`). Без правой границы посторонний `@dlb_lead_bot2` считался
 * бы упоминанием `@dlb_lead_bot`; без левой — `mail@dlb_lead_bot`, который
 * сам Telegram упоминанием не размечает вовсе (аудит 2026-08-28).
 * Ожидает уже приведённые к нижнему регистру аргументы.
 */
const HANDLE_CHAR = /[a-z0-9_]/;

function mentionsHandle(lowerText: string, lowerUsername: string): boolean {
  const needle = `@${lowerUsername}`;
  for (let i = lowerText.indexOf(needle); i !== -1; i = lowerText.indexOf(needle, i + 1)) {
    const prev = lowerText[i - 1];
    const next = lowerText[i + needle.length];
    const bounded =
      (prev === undefined || !HANDLE_CHAR.test(prev)) &&
      (next === undefined || !HANDLE_CHAR.test(next));
    if (bounded) return true;
  }
  return false;
}
