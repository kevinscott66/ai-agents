/**
 * Prometheus text-format metrics rendering for the Mini App server (T-320).
 *
 * Extracted from miniapp-server.ts (T-610 refactoring pass) as a self-contained
 * module — pure read-only DB/runtime snapshots, no request context. Each metric
 * is wrapped in try/catch — if a query fails (table missing in a test DB, etc.)
 * we drop the metric silently rather than 500 the whole scrape.
 */
import { db } from "./db.ts";
import { DAY_MS } from "./time-constants.ts";
import { getSchedulerLastRun } from "./db-maint.ts";
import { OPEN_TASK_STATUSES } from "./tasks.ts";
import { isMacOnline } from "./mac-bridge.ts";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function renderMetricLine(
  name: string,
  help: string,
  type: string,
  samples: Array<{ labels?: Record<string, string>; value: number }>,
): string {
  let out = `# HELP ${name} ${help}\n# TYPE ${name} ${type}\n`;
  for (const s of samples) {
    let labels = "";
    if (s.labels && Object.keys(s.labels).length > 0) {
      const parts = Object.entries(s.labels).map(
        ([k, v]) => `${k}="${String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`,
      );
      labels = `{${parts.join(",")}}`;
    }
    out += `${name}${labels} ${s.value}\n`;
  }
  return out;
}

/**
 * Версия сборки — читается с диска один раз на процесс.
 *
 * Аудит 2026-08-29: `readFileSync` + `JSON.parse` стояли ВНУТРИ
 * `renderMetrics`, то есть синхронный поход на диск случался на каждый скрейп
 * Prometheus (обычно раз в 15 секунд) и на каждый вызов тула GET_METRICS — на
 * том же единственном потоке bun, которому принадлежат и SQLite, и все 12
 * ботов. За время жизни процесса версия не меняется. Мемо ленивое, а не на
 * уровне модуля: импорт файла не должен ходить на диск.
 */
let cachedVersion: string | null = null;

function buildVersion(): string {
  if (cachedVersion !== null) return cachedVersion;
  let version = "unknown";
  try {
    const pkgPath = fileURLToPath(new URL("../package.json", import.meta.url));
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    if (typeof pkg.version === "string") version = pkg.version;
  } catch {}
  cachedVersion = version;
  return version;
}

export function renderMetrics(): string {
  const lines: string[] = [];

  // agent_team_build_info{version} — always 1.
  try {
    const version = buildVersion();
    lines.push(
      renderMetricLine(
        "agent_team_build_info",
        "Build info for the agent-team process.",
        "gauge",
        [{ labels: { version }, value: 1 }],
      ),
    );
  } catch {}

  // mac_bridge_connected — 0/1
  try {
    lines.push(
      renderMetricLine(
        "mac_bridge_connected",
        "1 if mac-bridge daemon is reachable, 0 otherwise.",
        "gauge",
        [{ value: isMacOnline() ? 1 : 0 }],
      ),
    );
  } catch {}

  // scheduler_last_run_age_seconds — seconds since the DB-maint scheduler last
  // ran (gcStaleTasks/archive). Emitted only when a run has happened; absence of
  // the gauge means "never run since boot".
  try {
    const last = getSchedulerLastRun();
    if (last != null) {
      const ageSeconds = Math.max(0, Math.floor((Date.now() - last) / 1000));
      lines.push(
        renderMetricLine(
          "scheduler_last_run_age_seconds",
          "Seconds since the DB-maintenance scheduler last ran.",
          "gauge",
          [{ value: ageSeconds }],
        ),
      );
    }
  } catch {}

  // tasks_open — все незакрытые задачи.
  //
  // Аудит 2026-08-12: список статусов был литеральным и неполным — awaiting_review
  // в нём не было. Именно этот статус висит дольше всех: gcStaleTasks awaiting_*
  // намеренно не трогает (ожидание человека, не зависшая работа), и второго
  // механизма, который бы такую задачу закрыл, не существует — в `approvals` нет
  // даже колонки под задачу. Счётчик был единственным, что могло о ней сообщить,
  // и как раз её не считал. Берём набор из FSM: терминальные статусы — те, из
  // которых переходов нет.
  try {
    const placeholders = OPEN_TASK_STATUSES.map(() => "?").join(",");
    const row = db
      .prepare(
        `SELECT COUNT(*) AS n FROM tasks WHERE status IN (${placeholders})`,
      )
      .get(...OPEN_TASK_STATUSES) as { n: number };
    lines.push(
      renderMetricLine(
        "tasks_open",
        `Number of tasks in non-terminal status (${OPEN_TASK_STATUSES.join("/")}).`,
        "gauge",
        [{ value: row.n }],
      ),
    );
  } catch {}

  // approvals_pending
  try {
    const row = db
      .prepare(`SELECT COUNT(*) AS n FROM approvals WHERE status = 'pending'`)
      .get() as { n: number };
    lines.push(
      renderMetricLine(
        "approvals_pending",
        "Number of approvals awaiting decision.",
        "gauge",
        [{ value: row.n }],
      ),
    );
  } catch {}

  // agent_actions_recent{status} GROUP BY status, last 24h
  //
  // Аудит 2026-08-20: раньше называлось `agent_actions_total` с `# TYPE counter`.
  // Оба слова были неправдой. Запрос ограничен окном `created_at >= now - 24h`,
  // то есть значение ПАДАЕТ, как только старые действия выпадают из окна.
  // Соседняя `messages_total` была не лучше: db-maint в 04:00 UTC переносит
  // старые строки в `messages_archive` и удаляет из источника, так что счётчик
  // каждую ночь обнуляется вниз.
  //
  // Для Prometheus каждое падение counter'а — это «процесс перезапустился,
  // счётчик сбросился в 0», и `increase()` дорисовывает разницу от нуля. То
  // есть график активности команды показывал бы всплеск ровно там, где
  // активности стало МЕНЬШЕ. Суффикс `_total` — общепринятая пометка «это
  // монотонный счётчик», по ней человек и строит `rate()`; поэтому меняем не
  // только тип, но и имя, иначе ложь просто переезжает в название.
  //
  // Переименование безопасно, но не по той причине, что стояла здесь раньше:
  // `METRICS_TOKEN` в `.env.example:105` как раз есть — пустой, с пометкой
  // «пусто = эндпоинт закрыт». Обоснование в том, что переменная пустая, а не
  // в том, что её не существует: пока `METRICS_TOKEN` не задан, `/metrics`
  // fail-closed и скрейпить его некому, так что имени ряда никто ещё не
  // запомнил. Как только владелец его задаст, переименование ряда станет
  // ломающим — тогда менять имя надо вместе с дашбордом (аудит 2026-09-11).
  try {
    const since = Date.now() - DAY_MS;
    const rows = db
      .prepare(
        `SELECT status, COUNT(*) AS n FROM agent_actions WHERE created_at >= ? GROUP BY status`,
      )
      .all(since) as { status: string; n: number }[];
    const samples = rows.map((r) => ({
      labels: { status: r.status ?? "unknown" },
      value: r.n,
    }));
    if (samples.length === 0) samples.push({ labels: { status: "none" }, value: 0 });
    lines.push(
      renderMetricLine(
        "agent_actions_recent",
        "Agent actions in the last 24h, by status. Sliding window, not a total.",
        "gauge",
        samples,
      ),
    );
  } catch {}

  // messages_stored — сколько строк лежит в `messages` ПРЯМО СЕЙЧАС.
  try {
    const row = db
      .prepare(`SELECT COUNT(*) AS n FROM messages`)
      .get() as { n: number };
    lines.push(
      renderMetricLine(
        "messages_stored",
        "Messages currently in the hot table (older rows move to messages_archive).",
        "gauge",
        [{ value: row.n }],
      ),
    );
  } catch {}

  return lines.join("\n") + (lines.length ? "\n" : "");
}
