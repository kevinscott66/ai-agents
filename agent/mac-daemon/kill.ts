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
