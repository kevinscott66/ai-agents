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
  /** Only set for a child spawned with detached:true (its own process group). */
  readonly processGroupId?: number;
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
  if (child.processGroupId !== undefined) {
    const pgid = child.processGroupId;
    if (!Number.isSafeInteger(pgid) || pgid <= 1 || pgid === process.pid) throw new Error('invalid child process group');
    const exists = () => {
      try { process.kill(-pgid,0); return true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; }
    };
    try { process.kill(-pgid,'SIGINT'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return 'gone'; throw error; }
    // The leader exiting is insufficient: a shell/tool may ignore SIGINT and
    // keep running in its group after the CLI has exited.
    const deadline = Date.now()+Math.max(0,graceMs);
    while (exists()) {
      if (Date.now() >= deadline) {
        try { process.kill(-pgid,'SIGKILL'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
        return 'killed';
      }
      await Bun.sleep(Math.min(20,Math.max(1,deadline-Date.now())));
    }
    return 'exited';
  }
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
