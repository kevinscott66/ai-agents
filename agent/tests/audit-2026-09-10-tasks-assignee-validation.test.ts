/**
 * Аудит 2026-09-10: `GET /api/tasks?assignee=` — последний непроверенный
 * фильтр этой ручки.
 *
 * `listTasksByAssignee` (tasks.ts) сравнивает `assigned_to = ?` точным
 * равенством: ни `LOWER`, ни нормализации. Канонический вид ключа в колонке
 * гарантируют ВСЕ семь писателей — `dispatch/tasks.ts` (createTask и
 * reassign, оба через `canonicalAssignee`), `action-dispatch.ts` (роль
 * делегата и жёстко зашитый «aieng»), `diagnostic.ts` (`pickResponsibleRole`
 * возвращает ключи из CHARACTERS), `dispatch/diagnostic-action.ts` (явный
 * `target_agent_key` проходит через `VALID_AGENT_KEYS`) и POST этой же ручки.
 * То есть неканоническому значению в колонке взяться неоткуда — и запрос по
 * нему не может совпасть НИКОГДА.
 *
 * Читающая ветка при этом отвечала на `?assignee=Backend` и на
 * `?assignee=devops` ровно тем же, чем на пустую очередь: 200 и
 * `{"tasks": []}`. Отличить опечатку от «дел нет» по ответу было нельзя.
 * Пишущая ветка ту же опечатку отклоняет 400-м с 2026-08-12 и своим
 * докблоком объясняет почему: «`assigned_to` — адрес очереди, так что
 * опечатка в форме = задача, невидимая всем, при 201 в ответе». У чтения
 * цена та же, только тише.
 *
 * Класс тот же, что закрыт в этом файле для `status` (аудит 2026-08-20) и в
 * тот же день 2026-09-10 для `/api/autonomy?agent=`, `/api/actions?status=` и
 * `/api/audit-logs?before=`.
 */
process.env.MINIAPP_BOT_TOKEN = "miniapp-assignee-validation-token";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { buildInitData } from "../lib/miniapp-auth.ts";
import { startMiniappServer, type MiniappServerHandle } from "../lib/miniapp-server.ts";
import { CHARACTERS } from "../characters/index.ts";
import { createTask } from "../lib/tasks.ts";

const BOT_TOKEN = "miniapp-assignee-validation-token";
const ADMIN_ID = 74321;
// Bun 1.3.14 в этой мастерской не умеет биндить эфемерный порт 0 — берём
// свободный фиксированный, как в соседних HTTP-тестах.
const TEST_PORT = Number(process.env.MINIAPP_ASSIGNEE_TEST_PORT ?? "28914");

function initData(): string {
  return buildInitData(BOT_TOKEN, {
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: `assignee-${Date.now()}`,
    user: JSON.stringify({ id: ADMIN_ID, username: "assignee", first_name: "A" }),
  });
}

let server: MiniappServerHandle;

async function get(pathAndQuery: string): Promise<{ status: number; body: any }> {
  const response = await fetch(`http://127.0.0.1:${server.port}${pathAndQuery}`, {
    headers: { "X-Telegram-Init-Data": initData() },
  });
  let body: any = null;
  try {
    body = await response.json();
  } catch {
    // Тело может быть пустым — тесту хватит статуса.
  }
  return { status: response.status, body };
}

beforeAll(() => {
  server = startMiniappServer({
    port: TEST_PORT,
    botToken: BOT_TOKEN,
    allowedUserIds: [ADMIN_ID],
    adminUserIds: [ADMIN_ID],
  });
});

afterAll(() => server.stop());

describe("GET /api/tasks?assignee= — словарь ролей", () => {
  test("несуществующая роль — 400, а не пустая очередь", async () => {
    const r = await get("/api/tasks?assignee=devops");
    expect(r.status).toBe(400);
    expect(String(r.body?.error)).toContain("devops");
    // Список допустимых — чтобы чинить опечатку по ответу, а не по исходнику.
    expect(r.body?.allowed).toEqual(CHARACTERS.map((c) => c.key));
  });

  test("регистр и пробелы нормализуются, как на записи", async () => {
    // `canonicalAssignee` — нормализатор, а не сторож: пишущая ветка кладёт в
    // колонку её результат. Значит читающей мало пропустить «Backend» — она
    // обязана спросить тем же ключом, иначе проверка пройдена, а совпадений
    // по-прежнему нет. Ровно на этом первая редакция правки и попалась.
    const chatId = -1_000_000 - Math.floor(Math.random() * 1_000_000);
    const t = createTask({
      chatId,
      createdBy: "orchestrator",
      assignedTo: "backend",
      title: "assignee normalization probe",
    });
    for (const raw of ["Backend", "  backend  ", "BACKEND"]) {
      const r = await get(
        `/api/tasks?assignee=${encodeURIComponent(raw)}&chat_id=${chatId}`,
      );
      expect(r.status).toBe(200);
      expect(r.body.tasks.some((x: any) => x.id === t.id)).toBe(true);
    }
  });

  test("каждый ключ из CHARACTERS принимается", async () => {
    for (const c of CHARACTERS) {
      const r = await get(`/api/tasks?assignee=${encodeURIComponent(c.key)}`);
      expect(r.status).toBe(200);
      expect(Array.isArray(r.body?.tasks)).toBe(true);
    }
  });

  test("канонический ключ по-прежнему находит свою задачу", async () => {
    // Изоляция — по чату, а не по выдуманному исполнителю: chat_id здесь
    // граница арендатора, и ветка assignee его учитывает (аудит 2026-08-28).
    const chatId = -1_000_000 - Math.floor(Math.random() * 1_000_000);
    const t = createTask({
      chatId,
      createdBy: "orchestrator",
      assignedTo: "qa",
      title: "assignee validation probe",
    });
    const r = await get(`/api/tasks?assignee=qa&chat_id=${chatId}`);
    expect(r.status).toBe(200);
    expect(r.body.tasks.some((x: any) => x.id === t.id)).toBe(true);
  });

  test("пустой `assignee=` — это «без фильтра», не опечатка", async () => {
    // Ветка ниже читает `if (assignee)`, то есть пустая строка туда не
    // попадает вовсе. 400 на неё был бы отказом на запрос без фильтра.
    const r = await get("/api/tasks?assignee=");
    expect(r.status).toBe(200);
  });

  test("без параметра — по-прежнему 200", async () => {
    const r = await get("/api/tasks");
    expect(r.status).toBe(200);
  });
});
