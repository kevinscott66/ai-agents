/**
 * Шаблоны постов DeLabs, кроме ежедневного дайджеста.
 *
 * T-740 «отработка активностей» — что из открытых активностей стоит сделать
 * прямо сейчас, по шагам и со сроком.
 * T-741 «итоги недели» — что за неделю произошло в новостях и что мы отработали
 * из активностей; периодический, значит выпуск кто-то проверяет.
 *
 * Формат обоих — стиль @delabsru: `эмодзи **жирный заголовок**` пунктом,
 * ПУСТАЯ СТРОКА между пунктами (эталон #75, регресс уже был), «Подробнее →» /
 * «Гайд →» ссылкой на страницу сайта, футер приклеивается публикатором
 * (`ensureChannelFooter`), а не шаблоном.
 *
 * Модуль чистый: ни gramjs, ни БД, ни сети. Всё, что он делает, — собирает
 * строку из уже готовых данных, и поэтому проверяется тестом целиком.
 *
 * ВАЖНО: ни одна из функций ничего не публикует. Первый выпуск обоих шаблонов
 * согласовывается с владельцем (T-740/T-741 — «формат согласовать до первой
 * публикации»), и дальше они идут тем же путём черновик → апрув, что и
 * дайджест.
 */
import {
  ruDate,
  ruDateRange,
  endSentence,
  itemEmoji,
  plainInline,
  oneLine,
  TG_MESSAGE_LIMIT,
} from "./delabs-text.ts";
import { plainTelegramLength } from "./telegram-format.ts";
import { DAY_MS } from "./time-constants.ts";

/**
 * Запас на футер в «плоских» символах. Канонический футер — 61, берём с
 * поправкой на разделяющую пустую строку и на то, что агент пишет свой.
 */
const FOOTER_RESERVE = 100;

/** Одна активность в посте. Поля — подмножество карточки сайта (`activities`). */
export interface ActivityEntry {
  /** Название проекта: «Monad», «Union». */
  project: string;
  /** Маркер пункта; пустой — подставится штатный. */
  emoji?: string;
  /** Что именно сделать — одно действие, повелительным наклонением. */
  action: string;
  /** Аирдроп / Поинты / NFT. НЕ статус — их путали, поэтому поля разные. */
  rewardType?: string;
  /** Подтверждён / Потенциальный / Ретродроп. */
  status?: string;
  /** Срок словами: «до 20 августа», «постоянно». */
  deadline?: string;
  /** Ссылка на гайд — страница активности на сайте. */
  url?: string;
}

/** Новость недели. Подмножество карточки `digests`. */
export interface RecapNews {
  emoji?: string;
  title: string;
  blurb: string;
  url?: string;
}

/** Активность, отработанная за неделю. */
export interface RecapActivity {
  emoji?: string;
  project: string;
  /** Что сделано: «прошли тестнет», «закрыли 5 из 7 шагов». */
  done: string;
  url?: string;
}

/**
 * Пункт списка: `эмодзи **заголовок**`, затем строка текста, затем ПУСТАЯ
 * строка. Пустая строка между пунктами — не косметика: без неё Telegram
 * склеивает пункты в стену текста (эталон #75, регресс `digest-spacing`).
 */
function pushItem(lines: string[], head: string, body: string[]): void {
  lines.push(head);
  for (const b of body) if (b) lines.push(b);
  lines.push("");
}

/**
 * Внешнее поле в шаблон: сначала в одну строку и под потолок, потом обезвредить
 * разметку. Порядок важен — `plainInline` длину не увеличивает, поэтому потолок
 * `oneLine` остаётся потолком результата.
 */
function field(s: string | undefined, max: number): string {
  return plainInline(oneLine(s ?? "", max));
}

/**
 * «Гайд →» ссылкой, если ссылка есть; иначе пусто (черновик её ещё не знает).
 *
 * Аудит 2026-08-28: ссылка не проверялась ничем, кроме `trim()`, а собирается
 * она в тулах как `${SITE_BASE}/digest/${id}`, где база — env
 * (`tools/weekly-draft.ts:48`). `DELABS_SITE_BASE=delabs.space` даёт
 * `[Подробнее →](delabs.space/digest/1)`, а пустое значение — `(/digest/1)`.
 * Для Telegram это href без схемы: ответ «unsupported URL protocol», то есть
 * не отправляется ВЕСЬ пост, а не теряется одна ссылка. Скобка внутри адреса
 * рвёт markdown-ссылку ровно так же. Пропускаем только http(s) без скобок и
 * пробелов; всё прочее — не ссылка, и пункт печатается без неё.
 */
function moreLink(url: string | undefined, label: string): string {
  const u = (url ?? "").trim();
  if (!/^https?:\/\/[^\s)]+$/i.test(u)) return "";
  return `[${label} →](${u})`;
}

/**
 * Строка пункта: текст и ссылка на него.
 *
 * Аудит 2026-08-28: ссылка приходила со своим ведущим пробелом и приклеивалась
 * к тексту конкатенацией. Пустой `action`/`blurb` (поле необязательное, а
 * `oneLine` может вычистить его до пустоты) давал строку, начинающуюся с
 * пробела, — в Telegram он виден. Склеиваем здесь, где известны обе части.
 */
function itemBody(text: string, url: string | undefined, label: string): string {
  const link = moreLink(url, label);
  if (!text) return link;
  return link ? `${text} ${link}` : text;
}

/**
 * T-740. Пост «Отработка активностей».
 *
 * Аудит 2026-08-28: шаблон готов, но из прода его не зовёт никто — тулы
 * «отработка активностей» не существует (ср. tools/daily-draft.ts и
 * tools/weekly-draft.ts, у которых она есть). Читатели только в тестах, а
 * lib/site-ingest.ts:256 ссылается на вывод как на пример. Докблок в
 * настоящем времени читался как «пост выходит»: на этом можно построить
 * рассуждение о проде, которого нет. Держим как готовый шаблон, ждущий
 * вызова, — появится вызов, эту заметку надо снять. Сторожит
 * tests/audit-2026-08-28-delabs-templates-unused.test.ts.
 *
 * @param entries что отрабатываем; пустой список — пустая строка на выходе,
 *                публиковать нечего (постить шапку без пунктов бессмысленно).
 * @param now     дата поста; параметром, чтобы тест не зависел от часов.
 */
export function buildActivityRunText(entries: ActivityEntry[], now = new Date()): string {
  const items = entries.filter((e) => field(e.project, 80));
  if (!items.length) return "";
  const lines: string[] = [];
  lines.push("🛠 **Отработка активностей**");
  lines.push(`🗓️ ${ruDate(now)}`);
  lines.push("");
  lines.push("Что стоит сделать прямо сейчас — по шагам и без воды.");
  lines.push("");

  for (const e of items) {
    const meta: string[] = [];
    if (e.rewardType?.trim()) meta.push(`🎖 ${field(e.rewardType, 40)}`);
    if (e.status?.trim()) meta.push(`✅ ${field(e.status, 40)}`);
    if (e.deadline?.trim()) meta.push(`⌚️ ${field(e.deadline, 40)}`);
    pushItem(lines, `${itemEmoji(e.emoji)} **${field(e.project, 80)}**`, [
      itemBody(endSentence(field(e.action, 200)), e.url, "Гайд"),
      meta.join(" · "),
    ]);
  }

  lines.push("Не гонитесь за всем сразу: две активности, доведённые до конца, дают больше одной галочки в десяти.");
  return lines.join("\n").trimEnd();
}

/**
 * T-741. Пост «Итоги недели» — по новостям И по активностям.
 *
 * Оба блока необязательны, но хотя бы один должен быть непустым: неделя без
 * единого пункта — это не пост, а повод не выпускать его вовсе.
 *
 * @param weekEnd последний день недели (обычно воскресенье); начало считается
 *                как `weekEnd − 6 дней`, чтобы диапазон печатался целиком.
 */
export function buildWeeklyRecapText(args: {
  news?: RecapNews[];
  activities?: RecapActivity[];
  /** Одна строка планов; пустая — блок не печатается. */
  ahead?: string;
  weekEnd?: Date;
}): string {
  // Аудит 2026-08-28: заголовок пункта печатался как `**${field(...)}**` без
  // проверки, а `field` умеет вернуть пустоту из непустого входа: `"\u200B\u200B"`
  // переживает `trim()` (это Cf, а не пробел) и вычищается уже внутри `oneLine`.
  // В канал уходило `🔥 ****` — пункт без имени, зато с жирными звёздочками.
  // Пункт без заголовка — это не пункт: заголовок и есть его имя («Monad»),
  // по нему же режет описание карточки lib/site-ingest.ts. Такие выкидываем,
  // и если не осталось ничего — поста нет (это уже записано в докблоке выше).
  const news = (args.news ?? []).filter((n) => field(n.title, 90));
  const activities = (args.activities ?? []).filter((a) => field(a.project, 80));
  if (!news.length && !activities.length) return "";

  const end = args.weekEnd ?? new Date();
  const start = new Date(end.getTime() - 6 * DAY_MS);

  const lines: string[] = [];
  lines.push("🗓 **Итоги недели**");
  lines.push(ruDateRange(start, end));
  lines.push("");
  lines.push("Что произошло и что мы отработали.");
  lines.push("");

  if (activities.length) {
    lines.push("📌 **Активности**");
    lines.push("");
    for (const a of activities) {
      pushItem(lines, `${itemEmoji(a.emoji)} **${field(a.project, 80)}**`, [
        itemBody(endSentence(field(a.done, 200)), a.url, "Гайд"),
      ]);
    }
  }

  if (news.length) {
    lines.push("📰 **Новости**");
    lines.push("");
    for (const n of news) {
      pushItem(lines, `${itemEmoji(n.emoji)} **${field(n.title, 90)}**`, [
        itemBody(endSentence(field(n.blurb, 200)), n.url, "Подробнее"),
      ]);
    }
  }

  const ahead = field(args.ahead ?? "", 200);
  if (ahead) {
    lines.push(`⏳ **На следующей неделе:** ${endSentence(ahead)}`);
  }

  return lines.join("\n").trimEnd();
}

/**
 * Влезает ли пост в одно сообщение Telegram.
 *
 * Аудит 2026-08-28: из прода не зовётся ниоткуда. Единственный вызов был в
 * tools/weekly-draft.ts и ушёл 2026-08-21 на `fitsWeeklyCaption` — там пост
 * идёт подписью к баннеру, и мерить его лимитом сообщения было неверно
 * (см. последний абзац ниже: он объясняет, почему НЕ надо делать ровно то,
 * что теперь делает единственный публикатор). Оставлено как мерка для
 * будущих текстовых постов, но читать написанное ниже как описание
 * работающего пути нельзя. Сторожит
 * tests/audit-2026-08-28-delabs-templates-unused.test.ts.
 *
 * Шаблоны собираются из данных переменной длины, а публикатор режет текст на
 * куски по границам строк. Проверять надо ДО отправки и с запасом на футер.
 *
 * Аудит 2026-08-20: мерили сырую длину и запас в «байтах». Telegram считает
 * длину ПОСЛЕ разбора сущностей, а пост состоит из ссылок вида
 * `[Подробнее →](https://delabs.space/…)` — виден только текст, а в счёт шёл
 * весь URL. Замер на обычной неделе (6 новостей + 4 активности, блёрбы по
 * 200): 1995 сырых против 1605 «плоских», то есть перебор почти на четверть.
 * По сырой длине выкидывались бы пункты, которые на самом деле влезают.
 * Запас на футер тоже был взят с потолка: канонический футер — 242 сырых и
 * 61 «плоский» символ.
 *
 * Порог остаётся лимитом СООБЩЕНИЯ, а не подписи к фото. Баннер с подписью
 * режет `sendDigest` (`approve-poll.ts`), и разрыв «подпись + хвост» там
 * штатный путь, а не авария: пост доходит целиком. Резать пункты здесь ради
 * подписи в 1000 знаков значило бы терять содержание там, где его терять не
 * нужно.
 */
export function fitsOneMessage(text: string, footerReserve = FOOTER_RESERVE): boolean {
  return plainTelegramLength(text) + footerReserve <= TG_MESSAGE_LIMIT;
}
