import type { Context } from 'telegraf';
import { listTasksByChat, OPEN_TASK_STATUSES, type Task } from './tasks.ts';
import { isMacOnline, isUserAllowed, sendAssistantToMac } from './mac-bridge.ts';
import { parseCalendarDay, type CalendarDay } from './assistant-types.ts';
import { nativeAccess } from './native-access.ts';
import { logToolCall } from './audit.ts';
import { createContext, formatContextList, listContexts, MAX_CONTEXTS_PER_CHAT, parseContextCommand, switchContext, type ContextCommand } from './chat-contexts.ts';

export type AssistantCommand = 'morning' | 'evening' | 'calendar' | 'workspace' | 'pair' | 'revoke' | 'alerts_on' | 'alerts_off';
export function parseAssistantCommand(text: string): AssistantCommand | null {
  const t = text.trim().toLowerCase().replace(/[.,!?:;]+$/u, '').replace(/^агент[\s,:—-]+/u, '').trim();
  if (t === '/alerts_on' || t === 'включи уведомления') return 'alerts_on';
  if (t === '/alerts_off' || t === 'выключи уведомления') return 'alerts_off';
  if (t === '/pair_native') return 'pair';
  if (t === '/revoke_native') return 'revoke';
  if (/^(начни (мой |рабочий )?день|начинаем день|что (у нас )?сегодня|утренняя сводка|\/day)$/.test(t)) return 'morning';
  if (/^(итоги дня|подведи итоги дня|вечерняя сводка|\/evening)$/.test(t)) return 'evening';
  if (/^(календарь|покажи календарь|встречи сегодня|\/calendar)$/.test(t)) return 'calendar';
  if (/^(открой рабочее окружение|открой рабочие приложения|\/workspace)$/.test(t)) return 'workspace';
  return null;
}
const plain = (s: string) => s.replace(/[\r\n\t\u0000-\u001f\u007f]/g, ' ').slice(0, 160);

export function prioritizeTasks(tasks: Task[], now = Date.now()): Task[] {
  return tasks.filter(t => OPEN_TASK_STATUSES.includes(t.status)).sort((a, b) => {
    const overdue = (t: Task) => t.deadline !== null && t.deadline < now ? 1 : 0;
    return overdue(b) - overdue(a) || b.priority - a.priority ||
      (a.deadline ?? Infinity) - (b.deadline ?? Infinity) || a.created_at - b.created_at;
  }).slice(0, 3);
}

export function formatCalendar(day: CalendarDay): string {
  const time = (s: string) => new Intl.DateTimeFormat('ru-RU', { timeZone: day.timeZone, hour: '2-digit', minute: '2-digit' }).format(new Date(s));
  const lines = day.events.slice(0, 12).map(e => `${e.allDay ? 'Весь день' : `${time(e.start)}–${time(e.end)}`} · ${plain(e.title)}`);
  const timed = day.events.filter(e => !e.allDay).sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  let lastEnd = -Infinity, overlaps = 0;
  for (const e of timed) {
    if (Date.parse(e.start) < lastEnd) overlaps++;
    lastEnd = Math.max(lastEnd, Date.parse(e.end));
  }
  return [`Календарь · ${day.date} (${day.timeZone})`, ...lines,
    ...(lines.length ? [] : ['Событий на сегодня нет.']),
    ...(day.truncated || day.events.length > 12 ? ['Показана часть событий.'] : []),
    ...(overlaps ? [`Пересечений по времени: ${overlaps}.`] : [])].join('\n');
}

export function formatPriorities(tasks: Task[], now = Date.now()): string {
  const selected = prioritizeTasks(tasks, now);
  return ['Три приоритета в этом чате', ...selected.map((t, i) => `${i + 1}. ${plain(t.title)}${t.deadline !== null && t.deadline < now ? ' — просрочено' : ''}${t.status === 'awaiting_approval' ? ' — ждёт подтверждения' : t.status === 'awaiting_review' ? ' — ждёт проверки' : ''}`),
    ...(selected.length ? [] : ['Открытых задач в этом чате нет.'])].join('\n');
}

export interface AssistantDependencies {
  tasks: typeof listTasksByChat;
  online: () => boolean;
  allowed: typeof isUserAllowed;
  mac: typeof sendAssistantToMac;
}
const defaults: AssistantDependencies = { tasks: listTasksByChat, online: isMacOnline, allowed: isUserAllowed, mac: sendAssistantToMac };

/**
 * /new, /chats, /switch — контексты разговора (lib/chat-contexts.ts). Работают
 * в любом чате, куда пускает allowlist: контекст общий для всех участников
 * группы, как и сама лента. В приложении свои разговоры, там команды не нужны.
 */
async function handleContextCommand(ctx: Context, command: ContextCommand, source: 'telegram' | 'native' | undefined): Promise<void> {
  const chatId = ctx.chat!.id;
  if (source === 'native') {
    await ctx.reply('Агент: в приложении новый разговор начинается кнопкой нового чата, а прежние лежат в списке и архиве.');
    return;
  }
  if (command.kind === 'new') {
    const r = createContext(chatId, command.title);
    await ctx.reply(r.ok
      ? `Агент: начал новый контекст №${r.context.number}${command.title ? ` «${r.context.title}»` : ''}. Прежнюю переписку я в нём не вижу; вернуться — /switch <номер>, список — /chats.`
      : `Агент: в этом чате уже ${MAX_CONTEXTS_PER_CHAT} контекстов, больше не заведу. Переключитесь на существующий: /chats.`);
    return;
  }
  if (command.kind === 'list') {
    await ctx.reply(formatContextList(listContexts(chatId)));
    return;
  }
  if (!command.target) {
    await ctx.reply('Агент: укажите номер из /chats, например /switch 1.');
    return;
  }
  const found = switchContext(chatId, command.target);
  await ctx.reply(found
    ? `Агент: переключился на №${found.number} «${found.title}» (сообщений: ${found.messages}).`
    : 'Агент: такого контекста в этом чате нет. Список — /chats.');
}

export async function handleAssistantCommand(ctx: Context, text: string, options: { source?: 'telegram' | 'native' } = {}, deps = defaults): Promise<boolean> {
  const contextCommand = parseContextCommand(text);
  if (contextCommand) {
    if (!ctx.chat?.id || !ctx.from?.id || ctx.from.is_bot) return true;
    await handleContextCommand(ctx, contextCommand, options.source);
    return true;
  }
  const command = parseAssistantCommand(text);
  if (!command) return false;
  const chatId = ctx.chat?.id;
  const userId = ctx.from?.id?.toString();
  if (!chatId || !userId || ctx.from?.is_bot) return true;
  // Personal data must never enter a team chat, including commands from the owner.
  const personal = ctx.chat?.type === 'private' && String(chatId) === userId && deps.allowed(userId);
  if ((['calendar', 'workspace', 'pair', 'revoke', 'alerts_on', 'alerts_off'].includes(command)) && !personal) {
    await ctx.reply('Агент: эта команда доступна владельцу в личном чате.');
    return true;
  }
  if (command === 'alerts_on' || command === 'alerts_off') {
    nativeAccess().alerts(userId, command === 'alerts_on');
    await ctx.reply(command === 'alerts_on'
      ? 'Агент: сообщу в личный Telegram-чат, если роль перестанет отвечать после трёх проверок, и когда связь восстановится. При неизменном состоянии молчу.'
      : 'Агент: уведомления о состоянии ролей выключены.');
    return true;
  }
  if (command === 'pair' && options.source === 'native') {
    await ctx.reply('Агент: код нового устройства можно получить только командой /pair_native в личном Telegram-чате.');
    return true;
  }
  if (command === 'pair' || command === 'revoke') {
    if (process.env.NATIVE_APP_ENABLED !== 'true') {
      await ctx.reply('Агент: iPhone-доступ пока не включён на сервере.');
      return true;
    }
    if (command === 'revoke') {
      nativeAccess().revoke(userId);
      await ctx.reply('Агент: доступ всех iPhone-устройств отозван. Уже начатые задачи проверь отдельно.');
    } else {
      await ctx.reply(`Код подключения iPhone (действует 5 минут, один раз):\n${nativeAccess().pair(userId)}`);
    }
    return true;
  }
  let status: 'ok' | 'error' = 'ok';
  let output: string;
  if (command === 'workspace') {
    try {
      const result = await deps.mac('open_workspace', userId, chatId);
      if (!result.ok || result.truncated) throw new Error('workspace_unavailable');
      const data = JSON.parse(result.stdout);
      if (!Array.isArray(data.opened) || !Array.isArray(data.failed)) throw new Error('invalid_workspace');
      output = `Агент: Mac принял открытие приложений: ${data.opened.length}.`;
      if (data.failed.length) { output += ` Не удалось открыть: ${data.failed.length}.`; status = 'error'; }
    } catch {
      status = 'error';
      output = 'Агент: рабочие приложения не открыты или открыты частично. Проверь связь с Mac и настройку MAC_WORKSPACE_APPS.';
    }
  } else {
    const sections = [`Агент · ${command === 'evening' ? 'Итоги дня' : command === 'calendar' ? 'Ваш календарь' : 'Начинаем день'}`];
    if (command !== 'calendar') {
      const tasks = deps.tasks(chatId);
      sections.push(formatPriorities(tasks));
      if (command === 'evening') {
        const zone = process.env.ASSISTANT_TIMEZONE || 'Europe/Moscow';
        const date = (n: number) => new Intl.DateTimeFormat('en-CA', { timeZone: zone }).format(n);
        const today = date(Date.now());
        const done = tasks.filter(t => t.status === 'done' && date(t.updated_at) === today);
        sections.push(`Завершено сегодня (${zone}): ${done.length}.`);
      }
    }
    if (command !== 'evening' && personal) {
      try {
        const result = await deps.mac('calendar_today', userId, chatId);
        if (!result.ok || result.truncated) throw new Error(result.error || 'calendar_unavailable');
        sections.push(formatCalendar(parseCalendarDay(result.stdout)));
      } catch (error) {
        status = 'error';
        const code = error instanceof Error ? error.message : '';
        sections.push(code === 'calendar_access_required'
          ? 'Apple Calendar: нужно разрешение на Mac. Откройте Системные настройки → Конфиденциальность и безопасность → Календари и разрешите доступ Агенту.'
          : code === 'calendar_disabled' ? 'Apple Calendar пока не подключён на Mac. Включите интеграцию календаря в настройках Mac-исполнителя.'
          : 'Apple Calendar недоступен. Проверь связь с Mac и разрешение доступа к календарю.');
      }
    } else if (command === 'morning') {
      sections.push('Личный календарь доступен владельцу в личном чате.');
    }
    sections.push(`Связь с Mac: ${deps.online() ? 'есть' : 'нет'}.`);
    output = sections.join('\n\n');
  }
  // Metadata only: no calendar bodies in shared action history/wiki/LLM context.
  logToolCall('ASSISTANT_COMMAND', { agentKey: 'orchestrator', chatId, payload: { command }, status });
  await ctx.reply(output);
  return true;
}
