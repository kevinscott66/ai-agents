/** Pure editorial state, copy projections and selection; no research or file I/O. */
import { ACTIVITY_TERM_FIELDS, activityRevisionErrors, projectActivityRevision } from "./activity-revision.mjs";
import { activityReviewMatches } from "./activity-review.mjs";
import { cleanEditorialSources, editorialSourceUrl } from "./editorial-sources.ts";
import { editorialStyleErrors } from './editorial-style.ts';

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
  spent?: string;
  url?: string;
  date?: string;
  origin?: string;
  sourceUrl?: string;
  raised?: string;
  investors?: string;
  dateReceive?: string;
  deadlineAt?: string | null;
  activityReviewRequired?: boolean;
  activityManualFields?: string[];
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
  editorialVersion?: number;
  /** Editorial review schedule; never an event/deadline date. */
  reviewAfter?: string;
  /** Human-owned activity terms read from snapshot/journal. */
  whatIs?: string; steps?: string[]; spent?: string; time?: string; rewardType?: string;
  status?: string; dateReceive?: string; deadlineAt?: string | null; url?: string;
  raised?: string; investors?: string;
  activityRevision?: { version: 1; whatIs: string; steps: string[]; spent: string; time: string;
    rewardType: string; status: string; dateReceive: string; deadlineAt: string | null;
    url: string; raised: string; investors: string };
  activityReview?: {version: number; inputHash: string; outputHash: string; boundAt: string};
}

export type EditorialFile = Partial<Record<Kind, Record<string, EditorialEntry>>>;

/**
 * Сколько материалов берём за прогон, по видам.
 *
 * Бюджет считается от таймаута юнита: один материал — это открыть 1-3 источника
 * и написать два-три поля, 30-60 секунд по журналу юнита (21.09.2026), вдвое
 * больше, если понадобился повтор (EDITORIAL_ATTEMPTS). Восемь штук даже с
 * повторами укладываются в TimeoutStartSec=1800. С 22.09.2026 таймер ходит
 * каждые полчаса, так что лимит почти никогда не упирается: канал за полчаса
 * столько не пишет.
 *
 * Виды разведены намеренно. Канал даёт 3-7 новостей в день и активность-другую;
 * с одним общим числом новости съедали бы весь бюджет, и активности не
 * редактировались бы никогда. Накопившийся долг разберётся за несколько дней —
 * это лучше, чем один прогон на полчаса.
 *
 * 23.09.2026: 8 -> 5. К написанию добавилась сверка с первоисточниками
 * (`vetted`), а это ещё один заход в SDK на материал, иногда два (претензия →
 * переписывание → повторная проверка). Прежние восемь перестали помещаться в
 * получасовое окно таймера, а прогон, налезающий на следующий, ничего не
 * ускоряет. Долг разберётся за лишний день — выдумка на странице стоит дороже.
 */
export const EDITORIAL_BATCH: Record<Kind, number> = { digests: 3, activities: 2 };

/** Заголовок-ярлык из канала: «Проект: Фраза». Ровно то, что мы заменяем. */
export const LABEL_TITLE = /^[\p{L}\p{N}_]+:\s/u;
export const SOURCE_ONLY_TITLE = /^(?:(?:публикация|пост|сообщение|запись)\s+в\s+(?:X|Twitter|соцсети)\b|[^.!?\n]{1,60}\s+(?:опубликовал[аи]?|разместил[аи]?)\s+(?:ссылк\p{L}*|пост|запись)\s+(?:на|в|о)\s)/iu;
export const EDITORIAL_VERSION = 3;
const DAY_MS = 24 * 60 * 60 * 1000;
const RECENT_REVIEW_DAYS = 30;

/** Scheduling metadata is not evidence that a forecast event occurred. */
export function digestReviewAfter(entry: Partial<EditorialEntry>, now: number): string {
  const actionable = /регистраци|заяв(?:к|ок)|клейм|снимок|снимка|дедлайн|airdrop|дроп/iu
    .test(`${entry.title ?? ""} ${entry.summary ?? ""} ${entry.body ?? ""}`);
  return new Date(now + (actionable ? 1 : 7) * DAY_MS).toISOString();
}

export function digestNeedsReview(row: RawDigest, entry: EditorialEntry, now: number): boolean {
  const text = `${entry.title ?? ""}\n${entry.summary ?? ""}\n${entry.body ?? ""}`;
  if (SOURCE_ONLY_TITLE.test(entry.title ?? "") || isEditorialMeta(text)) return true;
  const published = Date.parse(row.date ?? "");
  if (!Number.isFinite(published) || published < now - RECENT_REVIEW_DAYS * DAY_MS) return false;
  // A newly introduced policy must actually revisit recent automatic copy.
  const due = Date.parse(entry.reviewAfter ?? "");
  return (entry.editorialVersion ?? 1) < EDITORIAL_VERSION || !Number.isFinite(due) || due <= now;
}

/**
 * Короткий проверенный анонс не отклоняется ради объёма. Пределы защищают
 * от пустого/раздутого текста; факты отдельно проверяет vetted.
 */
export const TITLE_MIN = 35;
export const TITLE_MAX = 130;
export const SUMMARY_MIN = 80;
export const SUMMARY_MAX = 340;
// A sourced short news item can be complete below 600 characters. The old
// quota repeatedly rejected verified 350–599 character reports and encouraged
// padding with unverifiable context.
export const BODY_MIN = 350;
export const BODY_MAX = 3200;
export const LEGACY_BODY_REVIEW_BELOW = 600;

/** Editorial process messages are not articles, even when a checker finds no false claim. */
export function isEditorialMeta(value: string): boolean {
  return [
    /(?:в материал|в статью|в текст)[^.!?\n]{0,40}не (?:вошл|включ|перенес)/iu,
    /(?:формулировк|определени)[^.!?\n]{0,100}(?:из исходного поста[^.!?\n]{0,40})?не использу/iu,
    /(?:исходного поста|черновик)[^.!?\n]{0,80}(?:не использует|убран|исключ[её]н)/iu,
    /(?:материал|публикаци[яюи]|стать[яюи]|заметк[ауыи])[^.!?\n]{0,120}(?:не выйдет|не будет опубликован|без подтвержд[её]нных источников|не может быть (?:дополнен|подготовлен|опубликован))/iu,
    /нет подтвержд[её]нного события проекта/iu,
    /^(?:сообщени[ея]|информаци[яю]|сведения|заявлени[ея])[^.!?\n]{0,100}(?:требу[ею]т|нужда[ею]тся)[^.!?\n]{0,40}(?:подтверждени|проверк)[^.!?\n]{0,40}(?:первоисточник|официальн)/iu,
    /^(?:не удалось|не получилось|невозможно)[^.!?\n]{0,40}(?:подтвердить|проверить)[^.!?\n]{0,40}(?:само событие|основн|ключев)/iu,
    /^(?:(?:официального|независимого|достоверного)\s+)?подтверждени[ея][^.!?\n]{0,110}(?:нет|не найден|не получен)(?:[.!?]|\s|$)/iu,
    /^(?:событие|инцидент|сообщение)[^.!?\n]{0,110}(?:не подтвержд[её]н|не удалось подтвердить)/iu,
  ].some((pattern) => pattern.test(String(value ?? "")));
}

export function needsDigestEditorial(row: RawDigest): boolean {
  const title = String(row.title ?? "").trim();
  const body = String(row.body ?? "").trim();
  return LABEL_TITLE.test(title) || SOURCE_ONLY_TITLE.test(title) || title.length < TITLE_MIN || title.length > TITLE_MAX ||
    body.length < LEGACY_BODY_REVIEW_BELOW || isEditorialMeta(`${title}\n${row.summary ?? ""}\n${body}`);
}

/**
 * Предел заголовка допускает короткую новость и отклоняет перегруженную карточку.
 * Условия и статус остаются в интро и карточке, а не обязаны жить в title.
 */
export const ACT_TITLE_MIN = 35;
export const ACT_TITLE_MAX = 130;
export const INTRO_MIN = 240;
export const INTRO_MAX = 1200;

/**
 * Примеры берём из живой редактуры сайта, а не из констант в коде: стиль
 * правится на Mac, и вшитый сюда образец рано или поздно разойдётся с тем, что
 * читатель видит рядом на странице.
 */
export function styleExamples(manual: EditorialFile, kind: Kind = "digests", n = 2): EditorialEntry[] {
  const body = (e: EditorialEntry) => (kind === "digests" ? e.body : e.intro);
  // Образец задаёт агенту норму, поэтому берём только тексты, которые сами
  // проходят нынешние границы: короткий образец рядом с требованием «от 500»
  // агент читает как разрешение писать коротко.
  const fits = (e: EditorialEntry) => {
    const b = String(body(e)).length;
    const t = e.title.length;
    return kind === "digests"
      ? t >= TITLE_MIN && t <= TITLE_MAX && b >= BODY_MIN && b <= BODY_MAX &&
          String(e.summary ?? "").length >= SUMMARY_MIN
      : t >= ACT_TITLE_MIN && t <= ACT_TITLE_MAX && b >= INTRO_MIN && b <= INTRO_MAX;
  };
  const all = Object.values(manual[kind] ?? {}).filter(
    (e) => e && typeof e.title === "string" && typeof body(e) === "string" && fits(e) && !editorialStyleErrors(e).length,
  );
  return all.slice(-n);
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
  const deferred = deferReason(e);
  if (deferred) return [deferred];
  const bad: string[] = [];
  const title = String(e.title ?? "").trim();
  const summary = String(e.summary ?? "").trim();
  const body = String(e.body ?? "").trim();
  bad.push(...editorialStyleErrors({ title, summary, body }));

  if (title.length < TITLE_MIN || title.length > TITLE_MAX)
    bad.push(`заголовок ${title.length} символов, нужно ${TITLE_MIN}-${TITLE_MAX}`);
  if (title.endsWith(".")) bad.push("заголовок с точкой в конце");
  if (LABEL_TITLE.test(title)) bad.push("заголовок остался ярлыком «Проект: Фраза»");
  if (SOURCE_ONLY_TITLE.test(title)) bad.push("заголовок называет площадку вместо события проекта");
  if (title && title === d.title.trim() && (d.origin === "telegram" || LABEL_TITLE.test(title)))
    bad.push("заголовок не изменился");
  if (isEditorialMeta(`${title}\n${summary}\n${body}`)) bad.push("текст описывает редакционный отказ вместо события");
  if (summary.length < SUMMARY_MIN || summary.length > SUMMARY_MAX)
    bad.push(`лид ${summary.length} символов, нужно ${SUMMARY_MIN}-${SUMMARY_MAX}`);
  if (body.length < BODY_MIN || body.length > BODY_MAX)
    bad.push(`тело ${body.length} символов, нужно ${BODY_MIN}-${BODY_MAX}`);


  const items = Array.isArray(e.items) ? e.items : [];
  for (const it of items) {
    if (!it || typeof it.url !== "string" || !/^https?:\/\//.test(it.url))
      bad.push("в источниках есть ссылка не по http(s)");
    else {
      if (!String(it.text ?? "").trim()) bad.push(`у ссылки ${it.url} нет подписи`);
      if (editorialSourceUrl(it.url) !== it.url) bad.push(`в источнике остались реферальные или utm-параметры: ${it.url}`);
    }
  }
  // Тот же инвариант, что и в build-index.mjs: редактура может переименовать
  // ссылку и дописать свои, но потерять ссылку поста — нет.
  const have = new Set(items.map((it) => typeof it?.url === 'string' ? editorialSourceUrl(it.url) : undefined));
  const lost = (d.items ?? []).filter((it) => !have.has(editorialSourceUrl(it.url)));
  if (lost.length) bad.push(`потеряны ссылки поста: ${lost.map((l) => l.url).join(", ")}`);

  return bad;
}

/**
 * Активность сохраняет проверенные условия в интро. Заголовок должен называть
 * конкретное действие, но пунктуация и позиция проекта зависят от сюжета.
 */
export function checkActivity(e: Partial<EditorialEntry>, a: RawActivity): string[] {
  const deferred = deferReason(e);
  if (deferred) return [deferred];
  const bad: string[] = [];
  const title = String(e.title ?? "").trim();
  const intro = String(e.intro ?? "").trim();
  bad.push(...editorialStyleErrors({ title, intro }));
  if (e.activityRevision !== undefined) {
    bad.push(...activityRevisionErrors(e.activityRevision));
    for (const value of [e.activityRevision?.whatIs, ...(Array.isArray(e.activityRevision?.steps) ? e.activityRevision.steps : [])])
      if (typeof value === 'string') bad.push(...editorialStyleErrors({ body: value }));
  }

  if (title.length < ACT_TITLE_MIN || title.length > ACT_TITLE_MAX)
    bad.push(`заголовок ${title.length} символов, нужно ${ACT_TITLE_MIN}-${ACT_TITLE_MAX}`);
  if (title.endsWith(".")) bad.push("заголовок с точкой в конце");
  if (title && title === a.title.trim()) bad.push("заголовок не изменился");
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

/** Select factual/copy gaps across all published sources; preserve completed human edits. */
export function pickPending<T extends RawRecord>(
  rows: T[],
  manual: EditorialFile,
  auto: EditorialFile,
  kind: Kind = "digests",
  limit = EDITORIAL_BATCH[kind],
  retryAfter: Record<string, number> = {},
  now = Date.now(),
): T[] {
  // A manual title alone must not prevent research of a missing body. Human-written
  // bodies stay protected; old short automatic digests can be expanded once.
  const manualDone = Object.entries(manual[kind] ?? {}).filter(([, e]) =>
    kind === "digests" && Boolean(e.body?.trim()),
  ).map(([id]) => id);
  const byId = new Map(rows.map(row => [row.id, row]));
  const autoDone = Object.entries(auto[kind] ?? {}).filter(([id, e]) => {
    if (kind === 'activities' && e.activityRevision !== undefined) {
      if (activityRevisionErrors(e.activityRevision).length) return false;
      const projected = projectActivityRevision(byId.get(id), e, manual.activities?.[id]);
      if (activityRevisionErrors({version:1, ...Object.fromEntries(ACTIVITY_TERM_FIELDS.map(key => [key, projected[key]]))}).length) return false;
    }
    const revised = (e.editorialVersion ?? 1) >= 2;
    return kind === "digests"
      ? (e.body?.trim().length ?? 0) >= (revised ? BODY_MIN : LEGACY_BODY_REVIEW_BELOW) &&
          !digestNeedsReview(byId.get(id) ?? { id, title: e.title }, e, now)
      : Boolean(byId.get(id)) && activityReviewMatches(byId.get(id),
          projectActivityRevision(byId.get(id), e, manual.activities?.[id]), e.activityReview, now);
  }).map(([id]) => id);
  const done = new Set([...manualDone, ...autoDone]);
  const eligible = rows
    .filter((r) => (kind === "activities" || r.origin === "telegram" ||
      (kind === "digests" && ["api", "saved"].includes(r.origin ?? "") && (Boolean(auto.digests?.[r.id]) || needsDigestEditorial(r)))) &&
      !(kind === "activities" && r.activityReviewRequired === false) &&
      !done.has(r.id) && !(retryAfter[`${kind}:${r.id}`] > now))
    .sort((a, b) => String(b.date ?? "").localeCompare(String(a.date ?? "")) || a.id.localeCompare(b.id));
  // Recent stories remain first, but one slot per digest batch pays down the
  // historical backlog instead of letting each day's new posts starve it.
  if (kind === "digests" && limit >= 2 && eligible.length > limit)
    return [...eligible.slice(0, limit - 1), eligible.at(-1)!];
  return eligible.slice(0, limit);
}

/** The journal is the live human layer too; never regenerate its body behind the editor. */
export function withJournalEditorial(manual: EditorialFile, journal: unknown): EditorialFile {
  const result: EditorialFile = { ...manual, digests: { ...manual.digests }, activities: { ...manual.activities } };
  if (!Array.isArray(journal)) throw new Error("Invalid editorial journal");
  for (const edit of journal) {
    if (!["digest", "activity"].includes(edit?.kind) || !["patch", "add", "remove"].includes(edit.op) || (edit.kind !== "activity" && typeof edit.key !== "string")) continue;
    const key = edit.kind === "activity" ? (edit.key ?? edit.value?.id) : edit.key;
    if (typeof key !== "string" || !key) continue;
    const kind: Kind = edit.kind === "digest" ? "digests" : "activities";
    if (edit.op === "remove") {
      delete result[kind]![key];
      continue;
    }
    const fields: Partial<EditorialEntry> = {};
    for (const key of (kind === "digests" ? ["title", "summary", "body"] : ["title", "intro"]) as ("title" | "summary" | "body" | "intro")[]) {
      if (typeof edit.value?.[key] === "string") fields[key] = edit.value[key];
    }
    if (kind === "activities") {
      for (const key of ACTIVITY_TERM_FIELDS)
        if (Object.prototype.hasOwnProperty.call(edit.value ?? {}, key)) (fields as Record<string, unknown>)[key] = edit.value[key];
    }
    if (kind === "digests" && Array.isArray(edit.value?.items)) fields.items = edit.value.items;
    if (Object.keys(fields).length) result[kind]![key] = { ...result[kind]![key], ...fields };
  }
  return result;
}

/** Preserve a bounded private reason instead of hiding every failure behind one label. */
export function deferReason(e: Partial<EditorialEntry>): string | null {
  if (!("defer" in e) || e.defer !== true) return null;
  const reason = "reason" in e && typeof e.reason === "string"
    ? e.reason.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 600) : "";
  return "событие не подтверждено: оставить в редакционной очереди" + (reason ? `; причина: ${reason}` : "");
}

/** Resolve the human-owned activity copy for verification and receipt matching. */
export function activityCopy(proposal: Partial<EditorialEntry>, manual: Partial<EditorialEntry> = {}) {
  return Object.fromEntries((["title", "intro"] as const).map(key =>
    [key, String(typeof manual[key] === "string" && manual[key]!.trim() ? manual[key] : proposal[key] ?? "").trim()]));
}

/** Resolve the digest fields the site publishes after applying human edits. */
export function digestCopy(proposal: Partial<EditorialEntry>, manual: Partial<EditorialEntry> = {}): Partial<EditorialEntry> {
  const published = { ...proposal };
  for (const key of ["title", "summary", "body"] as const) {
    if (typeof manual[key] === "string" && manual[key]!.trim()) published[key] = manual[key]!.trim();
  }
  if (Array.isArray(manual.items)) {
    // The site strips tracking parameters after folding human edits too.
    // Verify those same source URLs without changing the owner's stored journal.
    published.items = cleanEditorialSources(manual.items);
  }
  return published;
}
