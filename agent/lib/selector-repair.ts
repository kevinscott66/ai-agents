/**
 * Починка селекторов покупок (этап 4 автономии): общий для сервера и демона
 * формат запроса, границы правки и неизменяемый текст задания.
 *
 * Когда Яндекс меняет вёрстку, SHOP_* отвечают unexpected_page или
 * price_unreadable. Агент зовёт SHOP_REPAIR, сервер шлёт на Mac кадр `repair`
 * {service, code} — без свободного текста: задание собирает сам демон из этого
 * модуля, и подсунуть в него чужие слова нельзя.
 *
 * Границы (проверяет демон, а не починщик):
 *  - правка — только файлы вёрстки сервиса и тесты (isRepairablePath);
 *  - починщику не выдаются git, gh, сеть и чтение вне рабочей копии: коммит,
 *    пуш ветки и PR делает демон после проверки списка изменённых файлов;
 *  - PR — только в новую ветку claude/selector-repair-*, мерж и выкатка
 *    остаются за владельцем;
 *  - в тело PR не попадает ни слова починщика: репозиторий публичный, а на
 *    странице профиля видны адрес и имя владельца.
 */

export const REPAIR_SERVICES = ["lavka", "eda", "market"] as const;
export type RepairService = (typeof REPAIR_SERVICES)[number];

/** Отказы, которые означают «вёрстка изменилась». Остальные селекторами не лечатся. */
export const REPAIR_CODES = ["unexpected_page", "price_unreadable"] as const;
export type RepairCode = (typeof REPAIR_CODES)[number];

export interface RepairRequest {
  service: RepairService;
  code: RepairCode;
}

export const REPAIR_SERVICE_LABEL: Record<RepairService, string> = {
  lavka: "Лавки",
  eda: "Еды",
  market: "Маркета",
};

/** Строгий разбор: лишние поля отбрасываются, неизвестное значение — отказ. */
export function parseRepairRequest(raw: unknown): RepairRequest | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (!REPAIR_SERVICES.includes(r.service as RepairService)) return null;
  if (!REPAIR_CODES.includes(r.code as RepairCode)) return null;
  return { service: r.service as RepairService, code: r.code as RepairCode };
}

/** Файлы вёрстки сервиса относительно agent/. */
export const REPAIR_FILES: Record<RepairService, readonly string[]> = {
  lavka: ["mac-daemon/shop-selectors.ts", "mac-daemon/shop-playwright.ts"],
  eda: ["mac-daemon/eda-selectors.ts", "mac-daemon/eda-playwright.ts"],
  market: ["mac-daemon/market-selectors.ts", "mac-daemon/market-playwright.ts"],
};

/**
 * Можно ли починщику менять этот путь (относительно корня репозитория, как его
 * печатает `git status`). Файлы вёрстки любого из трёх сервисов — общая
 * вкладка Playwright у них одна, — и тесты. Больше ничего: ни protocol.ts, ни
 * shop.ts, где живут сверка цены, корзина и кнопка оплаты.
 */
export function isRepairablePath(path: string): boolean {
  if (path.includes("..") || path.startsWith("/")) return false;
  const inAgent = path.startsWith("agent/") ? path.slice("agent/".length) : null;
  if (inAgent === null) return false;
  if (Object.values(REPAIR_FILES).some((files) => files.includes(inAgent))) return true;
  return /^tests\/[\w.-]+\.test\.ts$/.test(inAgent);
}

/** Ветка PR: сервис и минута по UTC — повтор в ту же минуту даст отказ git, а не чужую ветку. */
export function repairBranchName(service: RepairService, now: Date): string {
  const stamp = now.toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "-");
  return `claude/selector-repair-${service}-${stamp}`;
}

/** Команды, которые починщику разрешены (флаг --allowedTools). Всё остальное — отказ CLI. */
export function repairAllowedTools(): string[] {
  return [
    "Bash(bun mac-daemon/shop.ts selfcheck:*)",
    "Bash(bun test:*)",
    "Bash(bunx tsc --noEmit:*)",
  ];
}

/** Явно запрещённое: даже если в настройках владельца когда-нибудь появится разрешение. */
export function repairDisallowedTools(): string[] {
  return ["WebFetch", "WebSearch", "Bash(git:*)", "Bash(gh:*)", "Bash(curl:*)", "Bash(rm:*)"];
}

/** Неизменяемое задание починщику. Свободного текста извне в нём нет. */
export function buildRepairPrompt(req: RepairRequest): string {
  const files = REPAIR_FILES[req.service].map((f) => `  - ${f}`).join("\n");
  const symptom = req.code === "price_unreadable"
    ? "цена товара на странице перестала читаться (price_unreadable)"
    : "страница перестала узнаваться (unexpected_page)";
  const arg = req.service === "lavka" ? "" : ` ${req.service}`;
  return [
    `Задача: починить селекторы ${REPAIR_SERVICE_LABEL[req.service]} в mac-daemon. Симптом: ${symptom}.`,
    "Рабочая копия — свежая ветка от origin/main, текущая папка — agent/.",
    "",
    "Как смотреть страницу: `bun mac-daemon/shop.ts selfcheck" + arg + "` — открывает публичные страницы поиска",
    "в профиле покупок и печатает JSON: сколько элементов находит каждый селектор из *_TESTID и какие",
    "data-testid / data-auto / data-zone-name есть на странице. Текста страницы там нет — и не добывай его.",
    "Селектор с нулём совпадений при живой странице — кандидат на правку: найди в инвентаре новое имя.",
    "",
    "Менять можно только:",
    files,
    "  - tests/*.test.ts (обнови ожидания под новые селекторы)",
    "Остальные файлы не трогай: демон отвергнет правку целиком.",
    "",
    "Нельзя: класть товары в корзину, открывать корзину и оформление, нажимать кнопки на сайте,",
    "входить в Яндекс, решать капчу, смотреть адреса и карты. Если selfcheck вернул captcha или",
    "login_required — остановись и напиши это одной строкой.",
    "",
    "После правки: снова selfcheck (нужные селекторы находят элементы), затем",
    "`bun test tests/` по тестам затронутых модулей и `bunx tsc --noEmit -p .`.",
    "Коммит, пуш и PR сделает демон — git и gh тебе недоступны.",
    "",
    "В конце — три-пять строк по-русски: какие селекторы поменял и почему. Без адресов, имён и телефонов.",
  ].join("\n");
}

export interface SelfcheckSummary {
  status: string;
  selectors: Record<string, number>;
}

/** Селекторы с нулём совпадений — для тела PR и сообщения владельцу. */
export function emptySelectors(s: SelfcheckSummary | null): string[] {
  if (!s) return [];
  return Object.entries(s.selectors).filter(([, n]) => n === 0).map(([k]) => k).sort();
}

/** Тело PR: только то, что демон знает сам, — ни слова из вывода починщика. */
export function repairPrBody(req: RepairRequest, changed: readonly string[], before: SelfcheckSummary | null, after: SelfcheckSummary | null): string {
  const list = (xs: readonly string[]) => (xs.length ? xs.map((x) => `\`${x}\``).join(", ") : "нет");
  return [
    `## Починка селекторов ${REPAIR_SERVICE_LABEL[req.service]}`,
    "",
    `Агент получил \`${req.code}\` и сам запустил починку на Mac (этап 4 автономии).`,
    "",
    `- Изменённые файлы: ${list(changed)}`,
    `- Селекторы без совпадений до правки: ${list(emptySelectors(before))}`,
    `- Селекторы без совпадений после правки: ${list(emptySelectors(after))}`,
    `- Статус страницы до / после: \`${before?.status ?? "?"}\` / \`${after?.status ?? "?"}\``,
    "",
    "Селекторы с нулём на публичных страницах поиска — не всегда поломка: корзина, оформление и окно адресов там не открываются.",
    "",
    "Мерж и выкатка — за владельцем. Демон проверил, что правка не выходит за файлы вёрстки и тесты.",
    "",
    "🤖 Generated with [Claude Code](https://claude.com/claude-code)",
  ].join("\n");
}

export const REPAIR_FAIL_CODES = [
  "repair_disabled",
  "repair_busy",
  "repair_setup_failed",
  "repair_run_failed",
  "repair_no_change",
  "repair_forbidden_paths",
  "repair_push_failed",
] as const;
export type RepairFailCode = (typeof REPAIR_FAIL_CODES)[number];

export type RepairOutcome =
  | { ok: true; branch: string; pr_url: string; changed: string[]; empty_before: string[]; empty_after: string[] }
  | { ok: false; code: RepairFailCode; branch?: string; changed?: string[]; detail?: string };

/** Ответ демона: JSON последней строкой вывода. Кривой — null. */
export function parseRepairOutcome(stdout: string): RepairOutcome | null {
  const line = stdout.trim().split("\n").pop() ?? "";
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  if (o.ok === true && typeof o.pr_url === "string" && /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/.test(o.pr_url)) {
    return o as unknown as RepairOutcome;
  }
  if (o.ok === false && REPAIR_FAIL_CODES.includes(o.code as RepairFailCode)) return o as unknown as RepairOutcome;
  return null;
}
