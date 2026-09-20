/**
 * site-editorial.ts — ежедневная редактура выпусков сайта delabs.space.
 *
 * Зачем. Сайт с 20.09.2026 догоняет канал сам: таймер `delabs-site-refresh`
 * дважды в час забирает посты и пересобирает корпус. Но канал пишет ярлыками —
 * «Fermah: Открыт Waitlist», — а рядом на сайте лежат 250 выпусков того же
 * происхождения, названных по-человечески: «кто что сделал — деталь с цифрой»,
 * с лидом и разбором на два абзаца. Разницу делал редакционный слой, и делался
 * он руками. Пока руки не дошли, свежий выпуск висит ярлыком.
 *
 * Этот инструмент — те же руки, только ежедневные и агентские. Через Claude
 * Agent SDK (подписка, WebSearch/WebFetch) он берёт выпуски из канала, у
 * которых редактуры ещё нет, читает первоисточники поста и пишет заголовок,
 * лид, тело и список источников по образцу самого сайта.
 *
 * Куда пишет и почему не туда, куда пишет человек. Редактура с Mac живёт в
 * `src/data/snapshot/editorial.json` и уезжает на сервер выкладкой. Если бы
 * агент писал в тот же файл, первый же `npm run deploy` затёр бы его работу
 * копией с Mac — ровно так сайт когда-то откатывался к старым выпускам, пока
 * `telegram.json` не стал серверным. Поэтому у агента свой файл в StateDirectory
 * юнита, а `build-index.mjs` кладёт его ПОД редактуру человека: правка руками
 * всегда сильнее. Ни один файл не перезаписывает другой.
 *
 * Чего инструмент не делает: не трогает id (адреса страниц остаются), не
 * выбрасывает ни одной ссылки из поста и не публикует ничего в канал.
 *
 * Запуск: bun tools/site-editorial.ts (из /opt/agent-team, ради ../lib).
 * Таймер: delabs-site-editorial.timer. Сайт подхватит написанное сам на
 * ближайшей пересборке корпуса — отдельного шага публикации здесь нет.
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { buildSubscriptionEnv } from "../lib/subscription-env.ts";

export interface DigestItem {
  text: string;
  url: string;
}

/** Выпуск, как его собрал сайт из поста канала. */
export interface RawDigest {
  id: string;
  title: string;
  date?: string;
  summary?: string;
  body?: string;
  items?: DigestItem[];
  project?: string;
  origin?: string;
  sourceUrl?: string;
}

/** Запись редакционного слоя. Поля те же, что читает build-index.mjs. */
export interface EditorialEntry {
  title: string;
  summary: string;
  body: string;
  items?: DigestItem[];
  /** Служебное: кто и когда написал. build-index эти поля игнорирует. */
  at?: string;
  by?: string;
}

export interface EditorialFile {
  digests: Record<string, EditorialEntry>;
}

export const SITE_DIR = process.env.DELABS_SITE_DIR ?? "/opt/delabs";
export const AUTO_PATH =
  process.env.DELABS_EDITORIAL_AUTO ?? "/var/lib/delabs-editorial/editorial.json";

/**
 * Сколько выпусков берём за прогон.
 *
 * Канал даёт 3-7 сюжетов в день, и бюджет считается от таймаута юнита: один
 * выпуск — это открыть 1-3 источника и написать три поля, ~1.5-2 минуты.
 * Восемь штук укладываются в TimeoutStartSec=1800 с запасом. Если накопился
 * долг, он разберётся за несколько дней, а не одним прогоном на полчаса.
 */
export const EDITORIAL_BATCH = 8;

/**
 * Бюджет ходов на один выпуск.
 *
 * Здесь не ресёрч с нуля, как в daily-draft: тема, цифры и ссылки уже есть в
 * посте, агенту нужно их проверить и развернуть. Две-три ходки на источники
 * поста плюс запас на поиск недостающей детали.
 */
export const EDITORIAL_MAX_TURNS = 12;

export const EDITORIAL_SYSTEM = [
  "Ты — редактор сайта delabs.space (крипта, airdrop, AI×Web3).",
  "Пишешь по-русски, сухо и конкретно, без ИИ-клише («в эпоху цифровизации», «давайте разберёмся», «стоит отметить»).",
  "Ты не сочиняешь новость, а разворачиваешь уже случившуюся: факты берёшь из поста и его первоисточников.",
  "Ни одной цифры, даты или имени, которых нет в посте или в открытом тобой источнике. Нет факта — не пиши его.",
  "Ссылки не выдумываешь никогда.",
].join(" ");

/** Заголовок-ярлык из канала: «Проект: Фраза». Ровно то, что мы заменяем. */
export const LABEL_TITLE = /^[\p{L}\p{N}_]+:\s/u;

export const TITLE_MIN = 40;
export const TITLE_MAX = 160;
export const SUMMARY_MIN = 80;
export const BODY_MIN = 300;

/**
 * Примеры берём из живой редактуры сайта, а не из констант в коде: стиль
 * правится на Mac, и вшитый сюда образец рано или поздно разойдётся с тем, что
 * читатель видит рядом на странице.
 */
export function styleExamples(manual: EditorialFile, n = 2): EditorialEntry[] {
  const all = Object.values(manual.digests ?? {}).filter(
    (e) => e && typeof e.title === "string" && typeof e.body === "string" && e.body.length > BODY_MIN,
  );
  return all.slice(-n);
}

export function editorialPrompt(d: RawDigest, examples: EditorialEntry[]): string {
  const links = (d.items ?? []).map((it) => `- ${it.text}: ${it.url}`).join("\n") || "- (ссылок в посте нет)";
  const sample = examples
    .map((e, i) =>
      [
        `Образец ${i + 1}:`,
        `title: ${e.title}`,
        `summary: ${e.summary}`,
        `body: ${String(e.body).slice(0, 600)}`,
      ].join("\n"),
    )
    .join("\n\n");
  return [
    "Вот выпуск, который сайт забрал из телеграм-канала как есть. Перепиши его под сайт.",
    "",
    `Проект: ${d.project ?? "—"}`,
    `Дата: ${String(d.date ?? "").slice(0, 10)}`,
    `Заголовок в канале: ${d.title}`,
    `Текст поста: ${d.summary ?? ""} ${d.body ?? ""}`.trim(),
    "Ссылки поста:",
    links,
    d.sourceUrl ? `Сам пост: ${d.sourceUrl} (страница показывает эту ссылку отдельно — в items её не повторяй)` : "",
    "",
    "Так выглядят соседние выпуски на сайте — держись этого:",
    "",
    sample,
    "",
    "Что нужно:",
    `- title: ${TITLE_MIN}-${TITLE_MAX} символов, «кто что сделал — деталь с цифрой», без точки в конце.`,
    "  Форму «Проект: Фраза» не используй: именно её мы и заменяем.",
    `- summary: 2 предложения, от ${SUMMARY_MIN} символов, начинается с даты события полужирным (**20 сентября**),`,
    "  ключевые числа тоже полужирным.",
    `- body: 2-3 абзаца Markdown, от ${BODY_MIN} символов. Первый абзац объясняет, что это за проект и что произошло,`,
    "  дальше — детали, сроки, условия. Числа полужирным, ссылки в тексте — обычным Markdown.",
    "- items: список источников {text,url}. ВСЕ ссылки поста обязаны остаться (текст можно переписать),",
    "  к ним можно добавить те, что ты открыл сам.",
    "",
    `У тебя ${EDITORIAL_MAX_TURNS} ходов. Открой источники поста, при нехватке детали — один поиск.`,
    "Если проверить факт не вышло — не пиши его, короткий честный текст лучше выдуманного.",
    "",
    "Верни СТРОГО ОДИН JSON-объект и НИЧЕГО кроме него:",
    '{"title":"...","summary":"...","body":"...","items":[{"text":"...","url":"https://..."}]}',
  ]
    .filter((s) => s !== "")
    .join("\n");
}

/** Вытащить первый сбалансированный {...} из текста модели и распарсить. */
export function extractJson(raw: string): Record<string, unknown> {
  const start = raw.indexOf("{");
  if (start < 0) throw new Error("в ответе модели нет JSON-объекта");
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return JSON.parse(raw.slice(start, i + 1));
    }
  }
  throw new Error("незакрытые скобки JSON");
}

/**
 * Проверки перед публикацией.
 *
 * Редактура выходит на публичный сайт без человека, поэтому здесь не вкусовые
 * придирки, а то, что ломает страницу или возвращает нас к исходной беде:
 * пустые поля, заголовок-ярлык, потерянные ссылки поста. Выдумку модели этим
 * не поймаешь — против неё работают промпт и требование источников.
 */
export function checkEntry(e: Partial<EditorialEntry>, d: RawDigest): string[] {
  const bad: string[] = [];
  const title = String(e.title ?? "").trim();
  const summary = String(e.summary ?? "").trim();
  const body = String(e.body ?? "").trim();

  if (title.length < TITLE_MIN || title.length > TITLE_MAX)
    bad.push(`заголовок ${title.length} символов, нужно ${TITLE_MIN}-${TITLE_MAX}`);
  if (title.endsWith(".")) bad.push("заголовок с точкой в конце");
  if (LABEL_TITLE.test(title)) bad.push("заголовок остался ярлыком «Проект: Фраза»");
  if (title && title === d.title.trim()) bad.push("заголовок не изменился");
  if (summary.length < SUMMARY_MIN) bad.push(`лид ${summary.length} символов, нужно от ${SUMMARY_MIN}`);
  if (body.length < BODY_MIN) bad.push(`тело ${body.length} символов, нужно от ${BODY_MIN}`);

  const items = Array.isArray(e.items) ? e.items : [];
  for (const it of items) {
    if (!it || typeof it.url !== "string" || !/^https?:\/\//.test(it.url))
      bad.push("в источниках есть ссылка не по http(s)");
    else if (!String(it.text ?? "").trim()) bad.push(`у ссылки ${it.url} нет подписи`);
  }
  // Тот же инвариант, что и в build-index.mjs: редактура может переименовать
  // ссылку и дописать свои, но потерять ссылку поста — нет.
  const have = new Set(items.map((it) => it?.url));
  const lost = (d.items ?? []).filter((it) => !have.has(it.url));
  if (items.length && lost.length) bad.push(`потеряны ссылки поста: ${lost.map((l) => l.url).join(", ")}`);

  return bad;
}

/**
 * Убрать из источников ссылку на сам пост канала.
 *
 * Страница выпуска показывает её отдельной строкой «Источник», и в списке она
 * оказывается вторым экземпляром той же ссылки. У людей так сделано в двух
 * выпусках из двухсот пятидесяти — то есть это промах, а не приём. Просьбы в
 * промпте мало: она сбывается не каждый раз, а текст из-за такой мелочи
 * выбрасывать незачем — тише вычесть.
 */
export function dropSelfLink(items: DigestItem[], d: RawDigest): DigestItem[] {
  const fromPost = new Set((d.items ?? []).map((it) => it.url));
  return items.filter((it) => !d.sourceUrl || it.url !== d.sourceUrl || fromPost.has(it.url));
}

/** Кого ещё не редактировали: из канала, и ни у человека, ни у агента записи нет. */
export function pickPending(
  digests: RawDigest[],
  manual: EditorialFile,
  auto: EditorialFile,
  limit = EDITORIAL_BATCH,
): RawDigest[] {
  const done = new Set([...Object.keys(manual.digests ?? {}), ...Object.keys(auto.digests ?? {})]);
  return digests
    .filter((d) => d.origin === "telegram" && !done.has(d.id))
    .sort((a, b) => String(b.date ?? "").localeCompare(String(a.date ?? "")))
    .slice(0, limit);
}

export function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

/**
 * Запись через временный файл и rename: корпус пересобирается по таймеру
 * дважды в час и может прийти ровно в момент записи. rename в пределах одного
 * каталога атомарен — читатель увидит либо прежний файл, либо новый целиком.
 */
export function writeAtomic(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${Date.now()}.tmp`);
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  renameSync(tmp, path);
}

/** Один выпуск через подписку. Возвращает запись или бросает с причиной. */
export async function writeOne(d: RawDigest, examples: EditorialEntry[]): Promise<EditorialEntry> {
  let result = "";
  for await (const m of query({
    prompt: editorialPrompt(d, examples),
    options: {
      systemPrompt: EDITORIAL_SYSTEM,
      allowedTools: ["WebSearch", "WebFetch"],
      maxTurns: EDITORIAL_MAX_TURNS,
      permissionMode: "default",
      pathToClaudeCodeExecutable: process.env.CLAUDE_BIN,
      env: buildSubscriptionEnv(),
    } as any,
  })) {
    if ((m as any).type === "result") result = (m as any).result ?? "";
  }
  const parsed = extractJson(result) as Partial<EditorialEntry>;
  if (Array.isArray(parsed.items)) parsed.items = dropSelfLink(parsed.items, d);
  const bad = checkEntry(parsed, d);
  if (bad.length) throw new Error(bad.join("; "));
  return {
    title: String(parsed.title).trim(),
    summary: String(parsed.summary).trim(),
    body: String(parsed.body).trim(),
    items: (parsed.items ?? []).map((it) => ({ text: String(it.text).trim(), url: it.url })),
    at: new Date().toISOString(),
    by: "site-editorial",
  };
}

export async function main(): Promise<void> {
  const corpus = readJson<RawDigest[]>(join(SITE_DIR, "src/data/current/digests.json"), []);
  const manual = readJson<EditorialFile>(join(SITE_DIR, "src/data/snapshot/editorial.json"), {
    digests: {},
  });
  const auto = readJson<EditorialFile>(AUTO_PATH, { digests: {} });

  const pending = pickPending(corpus, manual, auto, EDITORIAL_BATCH);
  if (!pending.length) {
    console.log("[site-editorial] нередактированных выпусков нет");
    return;
  }
  console.log(`[site-editorial] без редактуры: ${pending.length} (берём по ${EDITORIAL_BATCH} за прогон)`);

  const examples = styleExamples(manual);
  let written = 0;
  for (const d of pending) {
    try {
      auto.digests[d.id] = await writeOne(d, examples);
      written++;
      console.log(`[site-editorial] ${d.id}\n    ${auto.digests[d.id].title}`);
      // Пишем после каждого выпуска: прогон может упереться в таймаут юнита, и
      // терять из-за этого уже написанное незачем.
      writeAtomic(AUTO_PATH, auto);
    } catch (err) {
      console.warn(`[site-editorial] пропущен ${d.id}: ${(err as Error).message}`);
    }
  }
  console.log(`[site-editorial] написано ${written} из ${pending.length}; сайт подхватит на пересборке корпуса`);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`[site-editorial] прогон упал: ${(err as Error).message}`);
    process.exit(1);
  });
}
