import type { AgentAction } from "./types";

export interface MacSession {
  id: string;
  project: string;
  mode: string;
  status: "running" | "completed" | "failed";
  /** Мс от эпохи — ровно то, что лежит в agent_actions.created_at. */
  createdAt: number;
  output?: string[];
  prompt: string;
  /** Тело скрыто сервером: смотрящий — не админ. */
  redacted: boolean;
}

/** Что MAC_RUN_CLAUDE кладёт в payload/result — сужаем `unknown` в одном месте. */
interface MacPayload {
  project?: string;
  mode?: string;
  prompt?: string;
}
interface MacResult {
  output?: string;
}

/** Как рисовать значок статуса сессии: подпись + пара цветов. */
export interface MacStatusBadge {
  text: string;
  background: string;
  color: string;
}

/**
 * Вид значка статуса для строки истории Mac.
 *
 * Аудит 2026-08-20. В `Mac.tsx` значок печатал сам ключ — `running`,
 * `completed`, `failed` — посреди русского интерфейса, при том что файл
 * импортировал `ACTION_STATUS_LABELS` и `label` и не звал их ни разу
 * (и не мог: ключи там — статусы *действия*, `ok`/`error`/…, а не сессии).
 *
 * Второе: фолбэк был `styles[status] || styles.running`, то есть незнакомый
 * статус красился синим «выполняется». Цвет утверждал самое дорогое — что
 * сессия ещё жива, — и противоречил бы тексту. Здесь неизвестное честно
 * остаётся собой: серый нейтральный фон и сам ключ подписью.
 *
 * Цвета подобраны под порог WCAG AA 4.5:1 с белым текстом (12px/500 — обычный
 * текст, не крупный). Прежние #3498db / #2ecc71 / #e74c3c давали 3.15 / 2.10 /
 * 3.82 — не брал ни один, а зелёный «завершена» был читаем хуже всех.
 * Инвариант закреплён тестом, который считает контраст, а не смотрит глазами.
 */
export function macStatusBadge(status: MacSession["status"]): MacStatusBadge {
  const white = "#ffffff";
  switch (status) {
    case "running":
      return { text: "выполняется", background: "#1f6fb2", color: white };
    case "completed":
      return { text: "завершена", background: "#1e8449", color: white };
    case "failed":
      return { text: "ошибка", background: "#c0392b", color: white };
    default:
      return { text: String(status), background: "#5d6d7e", color: white };
  }
}

/** Ровно та строка, которой сервер заменяет содержательные поля не-админу. */
export const REDACTED_NOTE = "(скрыто: доступно администратору)";

/**
 * Строка истории Mac из записи agent_actions.
 *
 * Аудит 2026-08-12: не-админу сервер отдаёт `payload` строкой-заглушкой
 * (redactContent в lib/miniapp-server.ts), а страница читала её как объект:
 * `payload.project` у строки — undefined, и в списке появлялось «Unknown
 * project» с пустым промптом. Выглядело как поломка данных, хотя это
 * работающее ограничение доступа. Показываем причину, а не мусор.
 */
export function toMacSession(action: AgentAction): MacSession {
  const redacted =
    typeof action.payload === "string" ||
    (action as { redacted?: boolean }).redacted === true;
  const payload: MacPayload =
    !redacted && action.payload && typeof action.payload === "object"
      ? (action.payload as MacPayload)
      : {};
  const result: MacResult =
    !redacted && action.result && typeof action.result === "object"
      ? (action.result as MacResult)
      : {};
  return {
    id: action.id,
    project: redacted ? REDACTED_NOTE : payload.project || "проект не указан",
    mode: redacted ? "—" : payload.mode || "ask",
    status:
      action.status === "ok"
        ? "completed"
        : action.status === "error"
          ? "failed"
          : "running",
    createdAt: action.created_at,
    prompt: redacted ? "" : payload.prompt || "",
    output: result.output ? [result.output] : [],
    redacted,
  };
}

/**
 * Что показать в панели «Вывод сессии».
 *
 * Аудит 2026-08-14: панель читала ТОЛЬКО живые чанки из подписки на
 * `mac.output` — событие, которого не существует. По репозиторию это имя
 * встречается ровно в двух местах: в самой подписке и в тесте, который
 * проверяет форму придуманного объекта. Сервер его не шлёт ниоткуда.
 *
 * При этом настоящий вывод рядом и загружен: `toMacSession` кладёт его в
 * `output` из `agent_actions.result.output`. То есть панель показывала
 * «Ожидание вывода… (SSE события mac.output)» вечно — над сессией, вывод
 * которой лежал в памяти той же страницы.
 *
 * Здесь сведение обоих источников и честная подпись, когда строк нет:
 * «скрыто» у не-админа, «ещё выполняется» у бегущей сессии и «не сохранён»
 * у завершившейся — три разных факта, которые одна фраза про SSE смешивала
 * в один.
 */
export interface MacOutputView {
  lines: string[];
  /** Почему строк нет. `null`, когда они есть. */
  note: string | null;
}

export function macOutputView(
  session: MacSession | undefined,
  live?: string[],
): MacOutputView {
  if (!session) return { lines: [], note: "Сессия не найдена." };
  const lines = [...(session.output ?? []), ...(live ?? [])];
  if (lines.length > 0) return { lines, note: null };
  if (session.redacted) return { lines: [], note: REDACTED_NOTE };
  if (session.status === "running") {
    return { lines: [], note: "Сессия ещё выполняется — вывод появится, когда она закончится." };
  }
  return { lines: [], note: "Вывод не сохранён." };
}

/**
 * Текст подтверждения для кнопки остановки.
 *
 * Аудит 2026-08-28: кнопка стояла внутри карточки сессии и называлась
 * «Остановить», а звала `api.macStop()` без аргументов — `stopMac`
 * (lib/mac-bridge.ts:373) шлёт демону один сигнал `stop` и следом роняет ВСЕ
 * ожидающие операции (`failAllPending("mac_stopped")`). `sessionId` уходил
 * только в подпись спиннера. Единственным предупреждением был `title=`, а его
 * в мобильном WebView Telegram не видно вовсе.
 */
export function stopAllConfirmText(running: number): string {
  const tail =
    running > 1
      ? ` Сейчас активных сессий: ${running} — остановятся все.`
      : "";
  return `Остановить ВСЕ процессы Claude на Mac?${tail}`;
}
