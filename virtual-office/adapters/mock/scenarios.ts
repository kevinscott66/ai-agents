import type { Activity, Agent } from "../../contracts/protocol";
export const SUMMARIES: Record<Activity, string> = {
  OFFLINE: "Демонстрация: исполнитель недоступен",
  IDLE: "Демонстрация: активных задач нет",
  THINKING: "Демонстрация: начата генерация ответа",
  READING: "Демонстрация: чтение клиента WebSocket",
  RESEARCHING: "Демонстрация: поиск документации",
  CODING: "Демонстрация: изменение обработки reconnect",
  TERMINAL: "Демонстрация: команда в терминале",
  TESTING: "Демонстрация: запуск тестов соединения",
  REVIEWING: "Демонстрация: проверка изменений",
  WAITING: "Демонстрация: ожидается решение владельца",
  WAITING_TOOL: "Демонстрация: ожидание инструмента",
  COMMUNICATING: "Демонстрация: сообщение коллеге",
  MEETING: "Демонстрация: обсуждение интерфейса событий",
  ERROR: "Демонстрация: тест соединения завершился ошибкой",
  DONE: "Демонстрация: задача завершена",
};
export function mockAgent(
  state: Activity,
  at = new Date().toISOString(),
  previous?: Agent,
): Agent {
  const active = state !== "IDLE" && state !== "OFFLINE";
  return {
    agentId: "backend",
    name: "Backend",
    role: "API · данные · интеграции",
    state,
    source: "mock",
    updatedAt: at,
    runId: active
      ? previous?.runId && !["DONE", "ERROR"].includes(previous.state)
        ? previous.runId
        : crypto.randomUUID()
      : null,
    taskId: active ? "demo-reconnect" : null,
    task: active ? "Восстановление WebSocket-соединения" : null,
    project: active ? "Virtual Office" : null,
    currentFile: [
      "CODING",
      "READING",
      "REVIEWING",
      "TESTING",
      "ERROR",
      "DONE",
    ].includes(state)
      ? "src/socket/client.ts"
      : null,
    repository: null,
    branch: active ? "demo/reconnect" : null,
    progress: state === "DONE" ? 1 : null,
    tests:
      state === "DONE"
        ? { passed: 8, failed: 0 }
        : state === "ERROR"
          ? { passed: 7, failed: 1 }
          : null,
    blocker:
      state === "WAITING"
        ? "Ожидается решение в демонстрационном сценарии"
        : state === "ERROR"
          ? "Mock timeout в тесте reconnect"
          : null,
    summary: SUMMARIES[state],
  };
}
