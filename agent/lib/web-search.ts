/**
 * Anthropic server-side web_search tool (T-web).
 *
 * Gives agents real-time web search WITHOUT any SSRF risk — the search runs on
 * Anthropic's servers, not ours; we never fetch attacker-controlled URLs. Off
 * by default (it costs ~$10 / 1000 searches on the Anthropic API on top of
 * tokens). Enable per deployment:
 *   WEB_SEARCH_ENABLED=true
 *   WEB_SEARCH_MAX_USES=3          # cap searches per agent RUN (default 3)
 *   WEB_SEARCH_ALLOWED_DOMAINS=…   # optional CSV allowlist
 *   WEB_SEARCH_BLOCKED_DOMAINS=…   # optional CSV blocklist
 */
import type Anthropic from "@anthropic-ai/sdk";
import { log } from "./log.ts";

function csv(name: string): string[] | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const list = raw.split(",").map((s) => s.trim()).filter(Boolean);
  return list.length ? list : undefined;
}

/**
 * Переменная задана разделителями и не дала ни одного домена (`","`, `" , "`,
 * `",,,"`).
 *
 * Аудит 2026-09-11: в этом перечне стояла и форма `" "` — ровно та, на которой
 * функция возвращает `false`. Значение из одних пробелов читается как
 * НЕзаданное (`raw.trim() === ""` выше), то есть fail-OPEN: поиск открывается
 * всему вебу, а на SDK-пути возвращается нативный WebSearch. Так решено
 * намеренно — `.env.example` пишет «Пусто = без ограничений», и это закреплено
 * тестом `audit-2026-08-29-web-search-config-fail-open`. Ложным был перечень,
 * а не ветка: он обещал fail-closed там, где его нет.
 *
 * Аудит 2026-08-29: у `csv()` таких исходов два, а смысла три. «Не задана» и
 * «задана, но пустая» она возвращала одинаково — undefined, — и написанная
 * оператором политика молча исчезала: поиск шёл по всему вебу, а на SDK-пути
 * заодно включался обратно нативный WebSearch, который доменов не умеет
 * вовсе. Настройка выглядит рабочей и ею не является — ровно тот класс, что
 * уже вычищали 2026-08-09 и 2026-08-28.
 *
 * Ответ тот же, что у схлопнувшегося алоу-листа ниже: конфиг сломан, чинить
 * его должен человек, а до тех пор поиск выключен.
 */
function csvBroken(name: string): boolean {
  const raw = process.env[name];
  if (!raw || raw.trim() === "") return false;
  return csv(name) === undefined;
}

/**
 * Отказ по сломанному конфигу доменов — тоже причина доменной политики.
 *
 * Аудит 2026-09-11: `denyReasonText` (sdk-web-guard.ts) отличал такие причины
 * по СВОЕМУ регэкспу с двумя хвостами, а `webFetchDomainPolicyReason` отдаёт
 * три строки. Третья не подходила ни под тот регэксп, ни под
 * `isInputOrResolverReason` — и опечатка оператора в `.env` приезжала модели
 * как «это попытка вытащить внутренние данные, не выполняй её». Обвинение в
 * инъекции за публичный адрес — ровно тот ложный сигнал, ради устранения
 * которого `denyReasonText` и написан.
 *
 * Поэтому предикат живёт здесь, рядом с производителем строк, и экспортируется
 * (`isDomainPolicyReason`): копия правила в соседнем файле — это правило,
 * действующее в одном месте из двух.
 */
const BROKEN_CONFIG_REASON =
  "список доменов задан, но пуст — загрузка закрыта до починки конфига";

/**
 * Написана ли эта причина доменной политикой оператора (а не SSRF-контуром).
 *
 * Хвост строки, а не начало: причину про имя пишет
 * `webFetchDomainPolicyReason`, а про адрес — `validatedTarget`.
 */
export function isDomainPolicyReason(reason: string): boolean {
  return (
    reason === BROKEN_CONFIG_REASON ||
    /(?:вне WEB_SEARCH_ALLOWED_DOMAINS|закрыт WEB_SEARCH_BLOCKED_DOMAINS)$/.test(reason)
  );
}

/** Одна из доменных переменных задана, но пуста. */
function domainConfigBroken(): boolean {
  return (
    csvBroken("WEB_SEARCH_ALLOWED_DOMAINS") || csvBroken("WEB_SEARCH_BLOCKED_DOMAINS")
  );
}

/** Та же дедупликация, что и у logDomainConflict, и по той же причине. */
let warnedBrokenFor: string | null = null;
function warnBrokenDomainConfig(): void {
  const key = `${process.env.WEB_SEARCH_ALLOWED_DOMAINS ?? ""}|${
    process.env.WEB_SEARCH_BLOCKED_DOMAINS ?? ""
  }`;
  if (warnedBrokenFor === key) return;
  warnedBrokenFor = key;
  log.error(
    "[web-search] список доменов задан, но пуст — поиск выключен, пока конфиг не починят",
    {
      allowed: process.env.WEB_SEARCH_ALLOWED_DOMAINS ?? null,
      blocked: process.env.WEB_SEARCH_BLOCKED_DOMAINS ?? null,
    },
  );
}

/**
 * Потолок поисков на ход. 0 — «нельзя ни одного», а не «поставь три».
 *
 * Аудит 2026-08-29: условие было `parsed > 0`, поэтому `WEB_SEARCH_MAX_USES=0`
 * возвращало дефолтные 3. Оператор писал «поиска нет» и получал поиск —
 * тот же фейл-опен, что и с пустым списком доменов. Ноль теперь значит ноль:
 * `webSearchTool()` при нём вообще не отдаёт инструмент.
 *
 * Мусор («abc», «-1») по-прежнему даёт дефолт, но больше не молча: сказать про
 * опечатку в имени лимита дешевле, чем потом объяснять счёт за поиск.
 */
let warnedMaxUsesFor: string | null = null;
function readMaxUses(): number {
  const raw = process.env.WEB_SEARCH_MAX_USES;
  const parsed = Number.parseInt(raw ?? "", 10);
  if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  if (raw !== undefined && raw.trim() !== "" && warnedMaxUsesFor !== raw) {
    warnedMaxUsesFor = raw;
    log.warn("[web-search] WEB_SEARCH_MAX_USES не число и не ноль — взят дефолт 3", {
      value: raw,
    });
  }
  return 3;
}

/**
 * Потолок поисков на прогон — то, что оператор задаёт в WEB_SEARCH_MAX_USES.
 *
 * Отдельный экспорт, чтобы вызывающий мог держать остаток: сам `max_uses`
 * в запросе считает только этот запрос (аудит 2026-09-11).
 */
export function webSearchRunBudget(): number {
  return readMaxUses();
}

export function webSearchEnabled(): boolean {
  return process.env.WEB_SEARCH_ENABLED === "true";
}

/**
 * Пропускает ли executor-потолок сетевую способность.
 *
 * Аудит 2026-08-27: `capabilityAllowlist` задокументирован в tool-loop.ts как
 * «потолок исполнителя, который запрос расширить не может», но фильтровал он
 * только имена из TOOLS. Сетевые инструменты приклеивались ПОСЛЕ фильтра и
 * мимо него: на raw-пути `req.tools = [...req.tools, ws]`, на SDK-пути
 * `sdkAllowedTools` дописывал WEB_TOOLS. Из-за этого временная роль из
 * SPAWN_ROLE с потолком `["SEARCH_WIKI","READ_WIKI"]` получала ещё и
 * WebSearch с WebFetch — то есть контекст, задуманный без сети вовсе, мог
 * вынести прочитанную приватную вики на произвольный публичный хост по
 * инъекции из самой вики (guardedWebFetch режет только приватные адреса).
 * Системный промпт такой роли пишет модель, а не человек.
 *
 * Отсутствие потолка (`undefined`) значит «ограничений нет» — это обычный
 * агент, а не временная роль.
 */
export function webCapabilityAllowed(
  name: "WebSearch" | "WebFetch",
  capabilityAllowlist?: readonly string[],
): boolean {
  if (!capabilityAllowlist) return true;
  return (
    capabilityAllowlist.includes(name) ||
    capabilityAllowlist.includes(`mcp__team__${name}`)
  );
}

/**
 * Конфиг инструмента web_search, либо null, когда он недоступен.
 *
 * `remaining` — сколько поисков ещё разрешено на ЭТОМ прогоне. Параметр не
 * косметика: `max_uses` у серверного инструмента Anthropic действует на один
 * HTTP-запрос, а прогон агента делает их до `MAX_TOOL_ITERS` штук плюс
 * финализирующий. Без остатка, который считает вызывающий, потолок в 3 поиска
 * превращался в 3 × 15 (аудит 2026-09-11, см. `runWithTools` в
 * lib/tool-loop.ts). Кто передать остаток не может — не передаёт, и получает прежнее «на запрос»; таких мест
 * быть не должно.
 */
export function webSearchTool(
  remaining?: number,
): Anthropic.Messages.WebSearchTool20250305 | null {
  if (!webSearchEnabled()) return null;
  if (domainConfigBroken()) {
    warnBrokenDomainConfig();
    return null;
  }
  const maxUses = remaining === undefined ? readMaxUses() : Math.max(0, remaining);
  // Ноль — это «нельзя», а не «сколько-то». Инструмент с max_uses: 0 API либо
  // отвергнет, либо истолкует по-своему; не предлагать его честнее.
  if (maxUses === 0) return null;
  const tool: Anthropic.Messages.WebSearchTool20250305 = {
    type: "web_search_20250305",
    name: "web_search",
    max_uses: maxUses,
  };
  const allowed = csv("WEB_SEARCH_ALLOWED_DOMAINS");
  const blocked = csv("WEB_SEARCH_BLOCKED_DOMAINS");
  if (allowed && blocked) {
    // Списки у Anthropic взаимоисключающие — отправить можно только один.
    // Раньше отсюда уходил алоу-лист, а блок-лист выбрасывался молча, и это
    // теряло интерес оператора целиком. Опасен перекрывающийся случай: домен
    // внесли в блок-лист, а из алоу-листа убрать забыли — поиск по нему
    // продолжался, и ни одной строки в логе об этом не было. Вычитание
    // сохраняет ОБА намерения в пределах одного списка, который API принимает.
    const kept = allowed.filter((d) => !blockedBy(d, blocked));
    if (kept.length === 0) {
      logDomainConflict("error", allowed, blocked, kept);
      // Пустой allowed_domains — это либо отказ API, либо поиск без
      // ограничений. И то и другое хуже выключенного поиска, поэтому здесь
      // закрываемся: конфиг сломан, чинить его должен человек.
      return null;
    }
    if (kept.length !== allowed.length) logDomainConflict("warn", allowed, blocked, kept);
    tool.allowed_domains = kept;
  } else if (allowed) tool.allowed_domains = allowed;
  else if (blocked) tool.blocked_domains = blocked;
  return tool;
}

/** Домен в каноничном для сравнения виде: без регистра и без ведущих точек. */
function normDomain(d: string): string {
  return d.trim().toLowerCase().replace(/^\.+/, "");
}

/**
 * Покрывает ли список доменов домен `d`.
 *
 * Название историческое: та же функция отвечает и на вопрос «покрывает ли
 * алоу-лист» (webFetchDomainPolicyReason) — семантика элемента списка у обоих
 * одна.
 *
 * Anthropic трактует домен в списке как «он и всё под ним», поэтому и здесь
 * блок `coindesk.com` снимает `www.coindesk.com`. Обратное неверно: блок
 * `bad.coindesk.com` не трогает сам `coindesk.com` — иначе одна запись в
 * блок-листе вычищала бы половину алоу-листа.
 */
function blockedBy(d: string, blocked: string[]): boolean {
  const x = normDomain(d);
  return blocked.some((b) => {
    const y = normDomain(b);
    return y !== "" && (x === y || x.endsWith(`.${y}`));
  });
}

/**
 * Задан ли БЕЛЫЙ список доменов.
 *
 * Нужно ровно одному вызывающему — `validatedTarget`, который решает судьбу
 * IP-литерала во входном url. Сама `webFetchDomainPolicyReason` тут не
 * годится: она отвечает про имя, а у литерала имени нет. Вопрос другой —
 * «сузил ли оператор веб до перечня имён»; если сузил, голый адрес в этот
 * перечень не входит по определению.
 *
 * Блок-лист сознательно не учитываем: «не ходить на tracker.example» —
 * утверждение об имени, и запрет всех литералов ради догадки о намерении
 * сломал бы легальные загрузки.
 */
export function webFetchAllowlistConfigured(): boolean {
  // Сломанный алоу-лист тоже считается заданным: вопрос здесь — «сузил ли
  // оператор веб», и ответ на него «да» независимо от того, разобрался ли
  // список. Иначе опечатка в переменной тихо снимала бы ограничение.
  return (
    csv("WEB_SEARCH_ALLOWED_DOMAINS") !== undefined ||
    csvBroken("WEB_SEARCH_ALLOWED_DOMAINS")
  );
}

/**
 * Политика доменов для WebFetch: причина отказа либо null.
 *
 * Аудит 2026-08-28: списки доменов не спрашивал НИКТО, кроме сборки нативного
 * web_search. При этом `sdkNativeWebSearchAllowed` (ниже по файлу) на заданных
 * списках нативный поиск выключает совсем — «агент остаётся с mcp__team__WebFetch, у
 * которого свой контур защиты». Контур там SSRF-овый: приватные адреса,
 * схемы, редиректы. Про домены оператора он не знает ничего.
 *
 * Складывается ровно наоборот задуманному: оператор сузил веб до белого
 * списка и получил вместо поиска по трём доменам загрузку чего угодно. На
 * проде USE_AGENT_SDK=true, то есть это и есть основной путь. Плюс блок-лист
 * читается интуитивно как «на эти домены не ходить» — а ходить на них было
 * можно, просто не через поиск.
 *
 * Семантика элемента списка та же, что у Anthropic и у `blockedBy`: запись
 * покрывает и сам домен, и всё под ним. Блок сильнее алоу — так же, как в
 * `webSearchTool`, где пересечение вычитается из алоу-листа.
 *
 * Проверяем только имена: IP-литералы (в том числе адреса из DNS-ответа,
 * которые `blockedFetchReason` прогоняет через себя повторно) под доменную
 * политику не подпадают и разбираются SSRF-частью.
 */
export function webFetchDomainPolicyReason(host: string): string | null {
  if (domainConfigBroken()) {
    warnBrokenDomainConfig();
    return BROKEN_CONFIG_REASON;
  }
  const allowed = csv("WEB_SEARCH_ALLOWED_DOMAINS");
  const blocked = csv("WEB_SEARCH_BLOCKED_DOMAINS");
  if (!allowed && !blocked) return null;
  const h = normDomain(host);
  if (h === "") return null;
  if (blocked && blockedBy(h, blocked)) {
    return `домен ${h} закрыт WEB_SEARCH_BLOCKED_DOMAINS`;
  }
  if (allowed && !blockedBy(h, allowed)) {
    return `домен ${h} вне WEB_SEARCH_ALLOWED_DOMAINS`;
  }
  return null;
}

/**
 * Ругаться один раз на конфиг, а не на каждый ход агента: `webSearchTool()`
 * зовётся из tool-loop на КАЖДЫЙ запрос к модели, и повтор в лог на каждом
 * ходу утопил бы то, ради чего сообщение писалось.
 */
let warnedFor: string | null = null;
function logDomainConflict(
  level: "warn" | "error",
  allowed: string[],
  blocked: string[],
  kept: string[],
): void {
  const key = `${level}|${allowed.join(",")}|${blocked.join(",")}`;
  if (warnedFor === key) return;
  warnedFor = key;
  const msg =
    level === "error"
      ? "[web-search] WEB_SEARCH_BLOCKED_DOMAINS закрыл весь WEB_SEARCH_ALLOWED_DOMAINS — поиск выключен"
      : "[web-search] домены есть в обоих списках — оставлены только незаблокированные";
  log[level](msg, {
    allowed,
    blocked,
    effective: kept,
    dropped: allowed.filter((d) => !kept.includes(d)),
  });
}

/** Только для тестов: сбросить дедупликацию предупреждения. */
export function _resetWebSearchWarnState(): void {
  warnedFor = null;
  warnedSdkFor = null;
  warnedBrokenFor = null;
  warnedMaxUsesFor = null;
}

/**
 * Можно ли выдать SDK-пути НАТИВНЫЙ WebSearch.
 *
 * Аудит 2026-08-28: `WEB_SEARCH_ENABLED` на SDK-пути починили 2026-08-21, а
 * остальные три ручки так и остались декорацией. `sdkAllowedTools` кладёт в
 * алоулист CLI голую строку "WebSearch" — у неё нет ни `max_uses`, ни
 * `allowed_domains`, ни `blocked_domains`, потому что `webSearchTool()`,
 * которая их и собирает, из этого модуля не зовётся вовсе.
 *
 * Аудит 2026-09-11: здесь стояло «в `sdk.d.ts` конфигурации нативного
 * WebSearch нет ни в каком виде, а PreToolUse-хук видит только `tool_input`
 * (запрос), но не домены выдачи». Вторая половина опровергается тем же
 * пакетом: `WebSearchInput` (sdk-tools.d.ts, @anthropic-ai/claude-agent-sdk
 * 0.3.175) — это `{ query, allowed_domains?, blocked_domains? }`, то есть
 * `tool_input` вызова WebSearch и ЕСТЬ объект с доменами, а
 * `PreToolUseHookSpecificOutput.updatedInput` позволяет его переписать.
 * Утверждение было верно узко про файл `sdk.d.ts` и ложно про пакет, который
 * назван в скобках.
 *
 * Поведение оставлено прежним, и вот почему: что рантайм CLI действительно
 * применит подставленный `allowed_domains`, типами не доказывается — это
 * проверяется только живым прогоном агента, а ошибка здесь открывает веб, а
 * не закрывает. Пока не проверено — закрываемся.
 *
 * На проде стоит USE_AGENT_SDK=true. Значит оператор, который сузил поиск до
 * своего белого списка, получал поиск по всему интернету и ни строчки в логе.
 * Это ровно тот же класс, что и фейл-опенный алоулист, вычищенный 2026-08-09:
 * настройка выглядит рабочей и ею не является.
 *
 * Раз применить нельзя — закрываемся: заданы домены, значит нативный
 * WebSearch не предлагаем совсем. Агент остаётся с `mcp__team__WebFetch`
 * (наш guardedWebFetch), у которого свой контур защиты. Оператор без списков
 * доменов ничего не теряет.
 */
export function sdkNativeWebSearchAllowed(): boolean {
  if (!webSearchEnabled()) return false;
  if (domainConfigBroken()) {
    // Пустой список — это тоже «оператор сузил веб»: молча вернуть ему
    // безлимитный нативный WebSearch было бы худшим из исходов.
    warnBrokenDomainConfig();
    return false;
  }
  if (readMaxUses() === 0) return false;
  const allowed = csv("WEB_SEARCH_ALLOWED_DOMAINS");
  const blocked = csv("WEB_SEARCH_BLOCKED_DOMAINS");
  if (!allowed && !blocked) return true;
  warnSdkDomainsUnenforceable(allowed, blocked);
  return false;
}

/** Та же дедупликация, что и у logDomainConflict, и по той же причине. */
let warnedSdkFor: string | null = null;
function warnSdkDomainsUnenforceable(
  allowed: string[] | undefined,
  blocked: string[] | undefined,
): void {
  const key = `${(allowed ?? []).join(",")}|${(blocked ?? []).join(",")}`;
  if (warnedSdkFor === key) return;
  warnedSdkFor = key;
  log.warn(
    "[web-search] на SDK-пути нативный WebSearch не умеет ограничение по доменам — " +
      "поиск для этого пути выключен, задан WEB_SEARCH_ALLOWED_DOMAINS/BLOCKED_DOMAINS",
    { allowed, blocked },
  );
}

/**
 * Сколько серверных поисков стоил ОДИН ответ API.
 *
 * Считать по блокам `server_tool_use` в контенте нельзя: часть из них может
 * прийти уже из истории, а часть ответов приходит с `stop_reason:"pause_turn"`,
 * где поиск состоялся, но результат ещё не разложен. `usage` — единственное
 * место, где Anthropic называет число обращений прямо, и биллинг считает по
 * нему же. Поле необязательное: старый ответ, мок в тестах или ветка без
 * серверных инструментов дают 0.
 */
export function webSearchRequestsUsed(resp: {
  usage?: { server_tool_use?: { web_search_requests?: number } | null } | null;
}): number {
  const n = resp.usage?.server_tool_use?.web_search_requests;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Счётчик нативных WebSearch на ОДИН прогон SDK — замена `max_uses`, который
 * на этом пути передать некуда (см. sdkNativeWebSearchAllowed).
 *
 * Возвращает текст отказа, когда лимит исчерпан, и null, когда вызов
 * разрешён. Считаем только сам `WebSearch`: `mcp__team__WebFetch` — другая
 * способность со своим контуром, и общий бюджет у них разный.
 *
 * Лимитер создаётся на прогон, а не на модуль: общий счётчик на процесс тихо
 * резал бы соседние диалоги.
 *
 * Аудит 2026-09-11: здесь было написано, что `max_uses` у raw-пути тоже «на
 * ход». Это неправда — он на ОДИН запрос к API, и raw-путь держит бюджет
 * прогона сам (`webSearchTool(remaining)` в `runWithTools`). Утверждение было
 * не только ложным, но и опасным: из него следовало, что две ветки одной
 * способности считают одинаково, тогда как raw-ветка не считала вовсе.
 */
export function makeSdkWebSearchLimiter(): (toolName?: string) => string | null {
  const max = readMaxUses();
  let used = 0;
  return (toolName) => {
    if (toolName !== "WebSearch") return null;
    used += 1;
    if (used <= max) return null;
    return (
      `[web-search] лимит WEB_SEARCH_MAX_USES=${max} исчерпан на этом прогоне ` +
      `(попытка ${used}) — поиск отклонён`
    );
  };
}
