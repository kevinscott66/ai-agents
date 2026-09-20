/**
 * site-editorial.ts — ежедневная редактура сайта delabs.space.
 *
 * Зачем. Сайт с 20.09.2026 догоняет канал сам: таймер `delabs-site-refresh`
 * дважды в час забирает посты и пересобирает корпус. Но канал пишет для канала —
 * «Fermah: Открыт Waitlist», «Отрабатываем тестнет от eCash и фармим дроп», — а
 * рядом на сайте лежат сотни материалов того же происхождения, названных
 * по-человечески: «кто что сделал — деталь, о которой читателю важно знать». У
 * выпуска к этому лид и разбор на два абзаца, у активности — интро на абзац.
 * Разницу делал редакционный слой, и делался он руками. Пока руки не дошли,
 * свежий материал висит текстом поста.
 *
 * Этот инструмент — те же руки, только ежедневные и агентские. Через Claude
 * Agent SDK (подписка, WebSearch/WebFetch) он берёт материалы канала, у которых
 * редактуры ещё нет, читает первоисточники поста и переписывает их по образцу
 * самого сайта.
 *
 * Правит только текст, которым материал представлен читателю: у выпуска —
 * заголовок, лид, тело и список источников, у активности — заголовок и интро.
 * Инструкцию «что делать» (steps), условия и статус активности не трогает: это
 * не редактура, а содержание, и ошибка там стоит читателю денег.
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

/** Два вида материалов, у каждого свой набор редактируемых полей. */
export type Kind = "digests" | "activities";
export const KINDS: Kind[] = ["digests", "activities"];

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

/** Активность (карточка «что сделать ради дропа»), как её собрал сайт. */
export interface RawActivity {
  id: string;
  title: string;
  intro?: string;
  whatIs?: string;
  steps?: string[];
  project?: string;
  time?: string;
  rewardType?: string;
  status?: string;
  url?: string;
  date?: string;
  origin?: string;
  sourceUrl?: string;
}

export type RawRecord = RawDigest & RawActivity;

/** Запись редакционного слоя. Поля те же, что читает build-index.mjs. */
export interface EditorialEntry {
  title: string;
  summary?: string;
  body?: string;
  intro?: string;
  items?: DigestItem[];
  /** Служебное: кто и когда написал. build-index эти поля игнорирует. */
  at?: string;
  by?: string;
}

export type EditorialFile = Partial<Record<Kind, Record<string, EditorialEntry>>>;

export const SITE_DIR = process.env.DELABS_SITE_DIR ?? "/opt/delabs";
export const AUTO_PATH =
  process.env.DELABS_EDITORIAL_AUTO ?? "/var/lib/delabs-editorial/editorial.json";

/**
 * Сколько материалов берём за прогон, по видам.
 *
 * Бюджет считается от таймаута юнита: один материал — это открыть 1-3 источника
 * и написать два-три поля, ~1.5-2 минуты. Восемь штук укладываются в
 * TimeoutStartSec=1800 с запасом.
 *
 * Виды разведены намеренно. Канал даёт 3-7 новостей в день и активность-другую;
 * с одним общим числом новости съедали бы весь бюджет, и активности не
 * редактировались бы никогда. Накопившийся долг разберётся за несколько дней —
 * это лучше, чем один прогон на полчаса.
 */
export const EDITORIAL_BATCH: Record<Kind, number> = { digests: 5, activities: 3 };

/**
 * Бюджет ходов на один материал.
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
 * Границы для активностей сняты с того, что человек уже написал: 162 карточки,
 * заголовки 76-123 символа, интро 404-825. Здесь они шире написанного — дело
 * проверок отбивать заведомо негодное, а не подгонять агента под медиану.
 */
export const ACT_TITLE_MIN = 60;
export const ACT_TITLE_MAX = 170;
export const INTRO_MIN = 350;
export const INTRO_MAX = 1200;

/**
 * Тире-разделитель в заголовке активности: «Проект сделал X — а вот оговорка».
 * Так написаны все 162 карточки, и это не украшение: вторая половина заголовка
 * — то, что читателю важно узнать до того, как он потратит время. «Токен и дроп
 * не анонсированы», «делайте это только с пустого адреса».
 */
export const ACT_TITLE_DASH = " — ";

/**
 * Примеры берём из живой редактуры сайта, а не из констант в коде: стиль
 * правится на Mac, и вшитый сюда образец рано или поздно разойдётся с тем, что
 * читатель видит рядом на странице.
 */
export function styleExamples(manual: EditorialFile, kind: Kind = "digests", n = 2): EditorialEntry[] {
  const body = (e: EditorialEntry) => (kind === "digests" ? e.body : e.intro);
  const all = Object.values(manual[kind] ?? {}).filter(
    (e) => e && typeof e.title === "string" && typeof body(e) === "string" && String(body(e)).length > INTRO_MIN,
  );
  return all.slice(-n);
}

const head = (d: RawRecord) =>
  [
    `Проект: ${d.project ?? "—"}`,
    `Дата: ${String(d.date ?? "").slice(0, 10)}`,
    `Заголовок в канале: ${d.title}`,
  ].join("\n");

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
    head(d),
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

export function activityPrompt(a: RawActivity, examples: EditorialEntry[]): string {
  const sample = examples
    .map((e, i) => [`Образец ${i + 1}:`, `title: ${e.title}`, `intro: ${e.intro}`].join("\n"))
    .join("\n\n");
  return [
    "Вот активность, которую сайт забрал из телеграм-канала как есть. Перепиши её под сайт.",
    "",
    head(a),
    `Интро из канала: ${a.intro ?? ""}`,
    a.whatIs ? `Что за проект (из карточки): ${a.whatIs}` : "",
    (a.steps ?? []).length ? `Шаги (НЕ переписывай, они нужны тебе для понимания сути):\n${(a.steps ?? []).map((s) => `- ${s}`).join("\n")}` : "",
    [a.time && `Время: ${a.time}`, a.rewardType && `Награда: ${a.rewardType}`, a.status && `Статус: ${a.status}`]
      .filter(Boolean)
      .join(" · "),
    a.url ? `Ссылка активности: ${a.url}` : "",
    a.sourceUrl ? `Сам пост: ${a.sourceUrl}` : "",
    "",
    "Так выглядят соседние карточки на сайте — держись этого:",
    "",
    sample,
    "",
    "Что нужно:",
    `- title: ${ACT_TITLE_MIN}-${ACT_TITLE_MAX} символов, без точки в конце, начинается с названия проекта.`,
    `  Обязательно с тире «${ACT_TITLE_DASH.trim()}»: слева — что проект запустил, справа — что читателю важно знать до того,`,
    "  как он потратит время: «токен и дроп не анонсированы», «поинты в токен не конвертируются», «нужен пустой кошелёк».",
    "  Канальные «отрабатываем», «фармим», «залетаем» не годятся: сайт пишет о проекте, а не зовёт за собой.",
    `- intro: один-два абзаца, ${INTRO_MIN}-${INTRO_MAX} символов. Что за проект, что именно он запустил, что делает участник,`,
    "  сколько это стоит и занимает, и чем награда является на самом деле. Названия и числа полужирным,",
    "  анонс — обычной Markdown-ссылкой. Если награда не обещана прямо — так и напиши, не обнадёживай.",
    "",
    "Инструкцию (шаги), условия, статус и суммы не переписывай: их редактирует человек, ты их не трогаешь.",
    "",
    `У тебя ${EDITORIAL_MAX_TURNS} ходов. Открой анонс проекта и, если нужно, его сайт.`,
    "Если проверить факт не вышло — не пиши его, короткий честный текст лучше выдуманного.",
    "",
    "Верни СТРОГО ОДИН JSON-объект и НИЧЕГО кроме него:",
    '{"title":"...","intro":"..."}',
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
 * То же для активности. Полей два, но требование к заголовку строже: карточка
 * зовёт читателя тратить время и иногда деньги, поэтому оговорка в заголовке
 * (та, что после тире) здесь не украшение, а обязательная часть.
 */
export function checkActivity(e: Partial<EditorialEntry>, a: RawActivity): string[] {
  const bad: string[] = [];
  const title = String(e.title ?? "").trim();
  const intro = String(e.intro ?? "").trim();

  if (title.length < ACT_TITLE_MIN || title.length > ACT_TITLE_MAX)
    bad.push(`заголовок ${title.length} символов, нужно ${ACT_TITLE_MIN}-${ACT_TITLE_MAX}`);
  if (title.endsWith(".")) bad.push("заголовок с точкой в конце");
  if (title && !title.includes(ACT_TITLE_DASH)) bad.push("в заголовке нет второй половины после тире");
  if (title && title === a.title.trim()) bad.push("заголовок не изменился");
  if (a.project && title && !title.toLowerCase().includes(a.project.toLowerCase()))
    bad.push(`в заголовке нет названия проекта (${a.project})`);
  if (intro.length < INTRO_MIN || intro.length > INTRO_MAX)
    bad.push(`интро ${intro.length} символов, нужно ${INTRO_MIN}-${INTRO_MAX}`);
  if (intro && intro === String(a.intro ?? "").trim()) bad.push("интро не изменилось");

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
export function pickPending<T extends RawRecord>(
  rows: T[],
  manual: EditorialFile,
  auto: EditorialFile,
  kind: Kind = "digests",
  limit = EDITORIAL_BATCH[kind],
): T[] {
  const done = new Set([...Object.keys(manual[kind] ?? {}), ...Object.keys(auto[kind] ?? {})]);
  return rows
    .filter((r) => r.origin === "telegram" && !done.has(r.id))
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

/** Один заход в Agent SDK по подписке. Возвращает текст последнего сообщения. */
async function ask(prompt: string): Promise<string> {
  let result = "";
  for await (const m of query({
    prompt,
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
  return result;
}

const stamp = () => ({ at: new Date().toISOString(), by: "site-editorial" });

/** Один выпуск. Возвращает запись или бросает с причиной. */
export async function writeOne(d: RawDigest, examples: EditorialEntry[]): Promise<EditorialEntry> {
  const parsed = extractJson(await ask(editorialPrompt(d, examples))) as Partial<EditorialEntry>;
  if (Array.isArray(parsed.items)) parsed.items = dropSelfLink(parsed.items, d);
  const bad = checkEntry(parsed, d);
  if (bad.length) throw new Error(bad.join("; "));
  return {
    title: String(parsed.title).trim(),
    summary: String(parsed.summary).trim(),
    body: String(parsed.body).trim(),
    items: (parsed.items ?? []).map((it) => ({ text: String(it.text).trim(), url: it.url })),
    ...stamp(),
  };
}

/** Одна активность. Пишем только заголовок и интро — остальное не наше. */
export async function writeActivity(a: RawActivity, examples: EditorialEntry[]): Promise<EditorialEntry> {
  const parsed = extractJson(await ask(activityPrompt(a, examples))) as Partial<EditorialEntry>;
  const bad = checkActivity(parsed, a);
  if (bad.length) throw new Error(bad.join("; "));
  return { title: String(parsed.title).trim(), intro: String(parsed.intro).trim(), ...stamp() };
}

export async function main(): Promise<void> {
  const manual = readJson<EditorialFile>(join(SITE_DIR, "src/data/snapshot/editorial.json"), {});
  const auto = readJson<EditorialFile>(AUTO_PATH, {});
  let written = 0;
  let seen = 0;

  for (const kind of KINDS) {
    const rows = readJson<RawRecord[]>(join(SITE_DIR, `src/data/current/${kind}.json`), []);
    const pending = pickPending(rows, manual, auto, kind);
    if (!pending.length) {
      console.log(`[site-editorial] ${kind}: без редактуры никого`);
      continue;
    }
    seen += pending.length;
    console.log(`[site-editorial] ${kind}: берём ${pending.length} (не больше ${EDITORIAL_BATCH[kind]} за прогон)`);
    const examples = styleExamples(manual, kind);
    const into = (auto[kind] ??= {});
    for (const r of pending) {
      try {
        into[r.id] = kind === "digests" ? await writeOne(r, examples) : await writeActivity(r, examples);
        written++;
        console.log(`[site-editorial] ${r.id}\n    ${into[r.id].title}`);
        // Пишем после каждого материала: прогон может упереться в таймаут
        // юнита, и терять из-за этого уже написанное незачем.
        writeAtomic(AUTO_PATH, auto);
      } catch (err) {
        console.warn(`[site-editorial] пропущен ${r.id}: ${(err as Error).message}`);
      }
    }
  }

  if (seen) console.log(`[site-editorial] написано ${written} из ${seen}; сайт подхватит на пересборке корпуса`);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`[site-editorial] прогон упал: ${(err as Error).message}`);
    process.exit(1);
  });
}
