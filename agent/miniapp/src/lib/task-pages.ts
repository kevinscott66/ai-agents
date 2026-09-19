/**
 * Страницы доски задач (AUD-012).
 *
 * `GET /api/tasks` отдаёт окно не шире 200 строк и `nextOffset` для
 * следующего. Доска держит «глубину» — сколько страниц читатель уже раскрыл
 * кнопкой «Показать ещё» — и на каждой перезагрузке (фильтр, событие SSE)
 * перечитывает их все подряд: иначе поток task.updated сбрасывал бы доску
 * обратно на первую страницу посреди чтения.
 *
 * Между запросами страниц доска может сдвинуться (агент создал задачу), и
 * граница окна съедет на строку: одна и та же задача окажется на двух
 * страницах. Отсюда дедупликация по id — первое вхождение выигрывает.
 */
import type { Task } from "./types";

export const TASK_PAGE_SIZE = 100;

export interface TaskPage {
  tasks: Task[];
  truncated: boolean;
  nextOffset?: number | null;
}

export async function loadTaskPages(
  fetchPage: (offset: number) => Promise<TaskPage>,
  depth: number,
): Promise<{ tasks: Task[]; truncated: boolean }> {
  const seen = new Set<string>();
  const tasks: Task[] = [];
  let offset = 0;
  let truncated = false;
  for (let i = 0; i < Math.max(1, depth); i++) {
    const page = await fetchPage(offset);
    for (const t of page.tasks) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      tasks.push(t);
    }
    truncated = Boolean(page.truncated);
    // Старый сервер без `nextOffset` — считаем сами: окно того же размера.
    const next = page.nextOffset ?? (truncated ? offset + TASK_PAGE_SIZE : null);
    if (!truncated || next == null) break;
    offset = next;
  }
  return { tasks, truncated };
}
