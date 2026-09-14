/**
 * Остановка дочерних процессов `claude` — отдельным файлом, без побочных
 * эффектов, чтобы это можно было проверить тестом. Сам `daemon.ts` при импорте
 * читает env, падает без него и сразу лезет в сеть, так что импортировать его
 * из теста нельзя.
 *
 * Аудит 2026-08-13: демон умел только `kill("SIGINT")` и только «убить всех».
 * Отсюда две дыры:
 *
 * 1. Прогон, не уложившийся в RUN_TIMEOUT_MS моста, никем не останавливался.
 *    Мост выбрасывал запись из pending и отвечал `mac_timeout`, а `claude` на
 *    маке продолжал работать — в режиме `bypass` выполняя команды без спроса,
 *    под id, который больше никто не ждёт. Точечной отмены не существовало:
 *    кадр `stop` убивает разом всё, включая чужой живой прогон.
 * 2. SIGINT — просьба, а не приказ. Процесс, застрявший в неотменяемом
 *    системном вызове или просто игнорирующий сигнал, оставался жить и после
 *    закрытия сокета, то есть навсегда: демон уже забыл о нём (`clear()`).
 */

export interface KillableChild {
  kill(signal?: number | NodeJS.Signals): void;
  readonly exited: Promise<unknown>;
}

/** Сколько ждать после SIGINT, прежде чем перейти к SIGKILL. */
export const KILL_GRACE_MS = 5_000;

export type KillOutcome = "exited" | "killed" | "gone";

/**
 * Мягко попросить процесс выйти, а если он не вышел за `graceMs` — убить.
 *
 * `exited` — «вышел сам по SIGINT», `killed` — «понадобился SIGKILL»,
 * `gone` — «процесс уже был мёртв, сигнал послать не удалось».
 */
export async function killChild(
  child: KillableChild,
  graceMs: number = KILL_GRACE_MS,
): Promise<KillOutcome> {
  try {
    child.kill("SIGINT");
  } catch {
    return "gone";
  }
  const TIMEOUT = Symbol("timeout");
  const raced = await Promise.race([
    child.exited.then(
      () => "exited" as const,
      () => "exited" as const,
    ),
    Bun.sleep(graceMs).then(() => TIMEOUT),
  ]);
  if (raced === "exited") return "exited";
  try {
    child.kill("SIGKILL");
  } catch {
    /* успел выйти между проверкой и добиванием */
  }
  return "killed";
}

/**
 * Остановить один прогон по его id. Возвращает `false`, если такого прогона
 * нет — например, он уже завершился сам, пока кадр отмены летел по сети.
 */
export function cancelRun(
  children: Map<string, KillableChild>,
  id: string,
  graceMs: number = KILL_GRACE_MS,
): boolean {
  const child = children.get(id);
  if (!child) return false;
  children.delete(id);
  void killChild(child, graceMs);
  return true;
}

/**
 * Занять id под новый прогон. `false` — id уже занят, прогон заводить нельзя.
 *
 * Аудит 2026-09-11: демон делал `activeChildren.set(id, child)` без проверки.
 * Карта — единственное, через что до процесса вообще можно дотянуться:
 * `cancelRun` ищет по id, `killAll` ходит по значениям. Поэтому второй `run` с
 * тем же id не «перезаписывал запись», а ТЕРЯЛ первый процесс: `claude`
 * остаётся жить на маке владельца — в режиме `bypass` выполняя команды без
 * спроса, — и его уже не достанет ни точечная отмена, ни кадр `stop`, ни
 * уборка при закрытии сокета. Ровно та дыра, которую круг 2026-08-13 закрыл
 * для таймаута и снова открыл здесь через повтор id.
 *
 * Повтор id не экзотика: мост переотправляет `run` после потерянного ответа, а
 * id для него — ключ записи в pending, не «номер попытки». Честный путь от
 * отказа не страдает — там id новый на каждый прогон.
 *
 * Отказ, а не вытеснение: убить чужой живой прогон ради нового значило бы
 * подменить одну потерю другой, а вернуть `false` — сказать мосту правду.
 */
export function registerChild(
  children: Map<string, KillableChild>,
  id: string,
  child: KillableChild,
): boolean {
  if (children.has(id)) return false;
  children.set(id, child);
  return true;
}

/** Остановить все прогоны. Возвращает, сколько их было. */
export function killAll(
  children: Map<string, KillableChild>,
  graceMs: number = KILL_GRACE_MS,
): number {
  const all = [...children.values()];
  children.clear();
  for (const child of all) void killChild(child, graceMs);
  return all.length;
}
