/**
 * Аудит 2026-08-11: шаблон окружения описывал меньше половины того, что читает код.
 *
 * `tests/env-example-tokens.test.ts` закрыл этот класс для 12 токенов ролей —
 * после того, как он дважды сломал прод на этой ветке: `0c6e59b` (голосовые не
 * распознавались — токен брался из несуществующей переменной) и `f27c73b`
 * (шаблон просил задать токен оркестратора под именем, которого нет в коде).
 * Но токены — это 12 имён из 84. На момент аудита в `.env.example` не было
 * пятидесяти двух остальных, и среди них не мелочь:
 *
 *   MAC_BRIDGE_SECRET   — общий секрет моста, через который на Mac исполняется код;
 *   MAC_ALLOW_BYPASS    — снимает проверку разрешений у того же моста;
 *   METRICS_TOKEN       — без него /metrics закрыт, с пустым — тоже (fail-closed);
 *   MINIAPP_ALLOWED_ORIGINS, MINIAPP_HOST — периметр Mini App;
 *   WIKI_PII_FILTER="0", OPENAI_PROMPT_REDACT="0" — выключают вычистку PII;
 *   TELEGRAM_ADMIN_USER_IDS — кто админ; USERBOT_* — весь юзербот.
 *
 * Недокументированная переменная опасна в обе стороны: её забывают задать
 * (тихий фолбэк вместо ошибки) и о ней не знают, что она есть (никто не
 * заметит, что PII-фильтр кто-то выключил). Поэтому инвариант жёсткий и
 * двусторонний: что читает код — то есть в шаблоне, а что в шаблоне — то
 * кто-то читает.
 *
 * Тест сканирует исходники, а не поддерживает список руками: список руками
 * протухает ровно так же, как шаблон.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { CHARACTERS } from "../characters/index.ts";

const ROOT = join(import.meta.dir, "..");

/** Директории с рантайм-кодом. Тесты и скрипты-пробы сюда не входят. */
const SCAN_DIRS = ["lib", "orchestrator", "characters"];

function collectSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...collectSources(full));
    } else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Тулы из tools/ в общий обход не входят: там же лежат пробы и бенчмарки, чьи
 * переменные в шаблоне не нужны. Но три тула DeLabs запускает systemd, и
 * именно `EnvironmentFile=` в этих юнитах делает незаданную переменную пустой
 * строкой. Список берём из самих юнитов, а не руками: рукописный протухает
 * ровно так же, как шаблон, который этот тест и сторожит.
 *
 * Аудит 2026-08-28: без этого DELABS_SITE_BASE, DELABS_DRAFTS_PENDING и
 * WEEKLY_AHEAD не были описаны в шаблоне вовсе — гейт до них не доходил.
 */
function systemdRunTools(): string[] {
  const unitDir = join(ROOT, "..", "deploy", "systemd");
  const out: string[] = [];
  for (const entry of readdirSync(unitDir)) {
    if (!entry.endsWith(".service")) continue;
    const unit = readFileSync(join(unitDir, entry), "utf8");
    if (!/^EnvironmentFile=/m.test(unit)) continue;
    for (const m of unit.matchAll(/^ExecStart=.*?\/tools\/([\w-]+\.ts)\s*$/gm)) {
      const file = join(ROOT, "tools", m[1]!);
      if (!out.includes(file)) out.push(file);
    }
  }
  return out;
}

const SYSTEMD_TOOLS = systemdRunTools();

const SOURCES = [
  ...SCAN_DIRS.flatMap((d) => collectSources(join(ROOT, d))),
  // Точки входа лежат в корне agent/ — там же читаются HANDLER_TIMEOUT_MS и др.
  ...readdirSync(ROOT)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => join(ROOT, f)),
  ...SYSTEMD_TOOLS,
];

/**
 * Комментарии выкидываем до сканирования: без этого в список попадают имена,
 * которые код УЖЕ не читает (например `TELEGRAM_TOKEN`, убранный в `0c6e59b`,
 * но упомянутый в шапке voice-handler.ts) — и тест начинает требовать вписать
 * в шаблон мёртвое имя, то есть ровно тот баг, который ловит.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[^\n]*?\/\/.*$/gm, (line) =>
    // Грубая защита от `"https://…"`: строку с `://` не режем целиком.
    line.includes("://") ? line : line.replace(/\/\/.*$/, ""),
  );
}

/**
 * Обёртки, которые получают ИМЯ переменной аргументом. Их нельзя не учитывать:
 * так читаются MINIAPP_PORT, WATCHDOG_*, весь блок ALERT_* и TOKEN_BUDGET_*.
 * Регулярка допускает перенос строки — `envInt(\n "ALERT_…",\n 360)` частый вид.
 */
const ENV_HELPERS = [
  "envInt",
  "_envPositiveInt",
  "parseBudgetEnv",
  "csv",
  // Аудит 2026-08-20: fix-chain.ts перевёл оба своих потолка на общий
  // санитайзер, и статические `process.env.INTER_AGENT_FIX_CHAIN_MAX_DEPTH` /
  // `process.env.DIAG_TASK_MAX_PER_HOUR` из кода пропали. Список именно за
  // этим и заведён — без записи сюда тест объявил бы оба имени сиротами в
  // шаблоне, хотя код их читает.
  "positiveEnvInt",
  // Аудит 2026-08-28: MINIAPP_PORT переехал с `_envPositiveInt` (потолок
  // таймера) на портовый `_envPort` (1..65535). Без записи сюда тест объявил
  // бы имя сиротой в шаблоне — что он и сделал, поймав переезд.
  "_envPort",
  // Аудит 2026-08-28: пять настроек mac-bridge переехали с локального
  // `positiveEnvInt` (префикс строки, без потолка) на `_envIntInRange`.
  "_envIntInRange",
  // Аудит 2026-08-28: DIGEST_HOUR_UTC и DB_MAINT_HOUR_UTC переехали с
  // тернарника `env.X ? Number(env.X) : def` на `_envHour` — у часа ноль
  // законное значение, и `" "` из systemd проходил как полночь. Гейт этот
  // переезд поймал ровно так, как задумано: имена стали сиротами в шаблоне.
  "_envHour",
];

function collectEnvNames(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  const add = (name: string, file: string) => {
    const list = found.get(name) ?? [];
    if (!list.includes(file)) list.push(file);
    found.set(name, list);
  };
  const helperRe = new RegExp(
    `\\b(?:${ENV_HELPERS.join("|")})\\(\\s*"([A-Z][A-Z0-9_]*)"`,
    "g",
  );
  for (const file of SOURCES) {
    const src = stripComments(readFileSync(file, "utf8"));
    const rel = file.slice(ROOT.length + 1);
    for (const m of src.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) add(m[1]!, rel);
    for (const m of src.matchAll(/process\.env\["([A-Z][A-Z0-9_]*)"\]/g)) add(m[1]!, rel);
    for (const m of src.matchAll(helperRe)) add(m[1]!, rel);
  }
  return found;
}

const READ_BY_CODE = collectEnvNames();

const ENV_EXAMPLE = readFileSync(join(ROOT, ".env.example"), "utf8");
const DECLARED = new Set(
  [...ENV_EXAMPLE.matchAll(/^([A-Z0-9_]+)=/gm)].map((m) => m[1]!),
);

/**
 * Имена, собираемые из шаблонной строки (`TOKEN_BUDGET_${key}`,
 * `USERBOT_SESSION_${upper}`): статически их не перечислить, в шаблоне они
 * присутствуют как префикс с пояснением.
 */
const DYNAMIC_PREFIXES = [
  "TOKEN_BUDGET_",
  "USERBOT_SESSION_",
  "USERBOT_ALLOWED_CHATS_",
];

/**
 * Объявлено в шаблоне, но кодом не читается — и это осознанно.
 * Всё, что не здесь и не читается, тест обязан завалить: имя, которое никто не
 * читает, — это и есть баг `f27c73b`.
 */
const DECLARED_WITHOUT_READER: Record<string, string> = {
  USE_AGENT_SDK: "читается через shouldUseSubscription(source)",
  // Токены ролей читаются через `process.env[def.envToken]` — имена приходят из
  // CHARACTERS, статически их в коде нет. Совпадение пиннит env-example-tokens.
  ...Object.fromEntries(
    CHARACTERS.map((c) => [c.envToken, "читается через process.env[def.envToken]"]),
  ),
  TELEMETR_TOKEN: "альтернатива TGStat, потребителя пока нет — помечено в шаблоне",
  // Аудит 2026-08-29: читает не код агента, а `deploy/vps-autonomous/autonomous-cycle.sh`
  // из того же /opt/agent-team/.env — шелл-скрипты в орбиту сканера не входят.
  // Пропуск в шаблоне при этом стоил бы ровно того же: незаданный токен — цикл
  // падает на `: "${CLAUDE_CODE_OAUTH_TOKEN:?}"`, и почему — знает только скрипт.
  CLAUDE_CODE_OAUTH_TOKEN: "читается autonomous-cycle.sh, не кодом агента",
  MAC_BRIDGE_AUTH_TIMEOUT_MS: "читается через bounded integer helper",
  MAC_BRIDGE_MAX_CONNECTIONS: "читается через bounded integer helper",
  MAC_BRIDGE_MAX_CONNECTIONS_PER_IP: "читается через bounded integer helper",
};

describe("agent/.env.example описывает всё, что читает код", () => {
  const missing = [...READ_BY_CODE.keys()]
    .filter((n) => !DECLARED.has(n))
    .sort();

  test("нет переменных, которые код читает, а шаблон не описывает", () => {
    const detail = missing
      .map((n) => `  ${n} — ${READ_BY_CODE.get(n)!.join(", ")}`)
      .join("\n");
    expect(missing.length === 0 ? "" : `\n${detail}`).toBe("");
  });

  test("нет имён в шаблоне, которых никто не читает", () => {
    const orphans = [...DECLARED].filter(
      (n) =>
        !READ_BY_CODE.has(n) &&
        !(n in DECLARED_WITHOUT_READER) &&
        !DYNAMIC_PREFIXES.some((p) => n.startsWith(p)),
    );
    expect(orphans.sort()).toEqual([]);
  });

  test("тулы под systemd попали в обход, а не потерялись", () => {
    // Пустой список означал бы, что регулярка по юнитам молча перестала
    // совпадать, — и tools/ снова выпал бы из гейта незаметно.
    expect(SYSTEMD_TOOLS.length).toBeGreaterThanOrEqual(3);
    expect(READ_BY_CODE.get("DELABS_SITE_BASE") ?? []).not.toEqual([]);
    expect(READ_BY_CODE.has("WEEKLY_AHEAD")).toBe(true);
  });

  test("сканер вообще что-то нашёл (защита от пустой регулярки)", () => {
    expect(SOURCES.length).toBeGreaterThan(50);
    expect(READ_BY_CODE.size).toBeGreaterThan(60);
    expect(READ_BY_CODE.has("ANTHROPIC_API_KEY")).toBe(true);
  });

  test("исключение из комментариев не прячет живые чтения", () => {
    // TELEGRAM_TOKEN убран в 0c6e59b и остался только в комментарии —
    // если он снова окажется в коде, это регрессия того фикса.
    expect(READ_BY_CODE.has("TELEGRAM_TOKEN")).toBe(false);
  });
});

describe("секретные переменные подписаны как секреты", () => {
  // Смысл: оператор не должен догадываться, что MAC_BRIDGE_SECRET — секрет.
  const SENSITIVE = [
    "GITHUB_TOKEN",
    "GH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "MAC_BRIDGE_SECRET",
    "METRICS_TOKEN",
    "SITE_INGEST_TOKEN",
    "USERBOT_SESSION_KEY",
    "TELEGRAM_API_HASH",
  ];
  for (const name of SENSITIVE) {
    test(`${name} объявлен пустым (значение — только в .env на сервере)`, () => {
      const line = ENV_EXAMPLE.split("\n").find((l) => l.startsWith(`${name}=`));
      expect(line).toBeDefined();
      expect(line!.slice(name.length + 1).split("#")[0]!.trim()).toBe("");
    });
  }
});
