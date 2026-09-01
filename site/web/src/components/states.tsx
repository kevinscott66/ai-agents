// Переиспользуемые состояния: скелетоны, пусто, ошибка.

import type { JSX } from "preact";
import { plural } from "../format";
import {
  IconAlertTriangle,
  IconCircleSlash,
  IconInbox,
  IconRotateCw,
  IconSearch,
} from "./icons";

/** Любая иконка из `icons.tsx`: все принимают необязательный `size`. */
type IconComponent = (props: { size?: number }) => JSX.Element;

/** Бейдж «N источников» — общий для карточки дайджеста и детальной страницы. */
export function SourceCountBadge({ count }: { count: number }) {
  return (
    <span class="badge badge-muted">
      {count} {plural(count, "источник", "источника", "источников")}
    </span>
  );
}

/**
 * Заголовок страницы раздела: <h1> + подзаголовок.
 *
 * Именно h1, а не h2: после редизайна (T-742) главная строит шапки блоков сама
 * (`home/HomeHead.tsx`), и SectionHead остался только на страницах разделов —
 * `/digests`, `/unlocks`, `/drops`, `/activities`, `/about`. Каждая из них была
 * страницей без единого h1: скринридер и поисковик начинали чтение сразу со
 * второго уровня, а первого не было вовсе.
 */
export function SectionHead({ title, sub }: { title: string; sub: string }) {
  return (
    <header class="section-head">
      <h1>{title}</h1>
      <p class="section-sub">{sub}</p>
    </header>
  );
}

export function Skeleton({ class: cls = "" }: { class?: string }) {
  return <div class={`skeleton ${cls}`} />;
}

export function SkeletonCards({ count = 3 }: { count?: number }) {
  return (
    <div class="cards">
      {Array.from({ length: count }).map((_, i) => (
        <div class="card" key={i}>
          <Skeleton class="sk-line sk-w40" />
          <Skeleton class="sk-line sk-w80" />
          <Skeleton class="sk-line sk-w100" />
          <Skeleton class="sk-line sk-w60" />
        </div>
      ))}
    </div>
  );
}

export function SkeletonRows({ count = 5 }: { count?: number }) {
  return (
    <div class="sk-rows">
      {Array.from({ length: count }).map((_, i) => (
        <Skeleton class="sk-line sk-row" key={i} />
      ))}
    </div>
  );
}

/**
 * Пусто — по типу данных, а не один ящик на всё (T-742).
 *
 * Раньше это была центрированная пунктирная коробка со знаком `∅`: она читается
 * как «здесь что-то сломалось», хотя пустой список — нормальное состояние.
 * Теперь блок прижат влево внутри рамки списка, иконка называет тип данных, а
 * действие ровно одно: две кнопки рядом заставляют выбирать там, где выбора
 * нет.
 *
 * `icon` — компонент из `icons.tsx`, не строка: глифы вроде `∅` скринридер
 * читает вслух («пустое множество»), а inline SVG с `aria-hidden` — нет.
 */
export function EmptyState({
  icon: Icon = IconInbox,
  text,
  action,
}: {
  icon?: IconComponent;
  text: string;
  action?: { label: string; onClick: () => void };
}) {
  return (
    <div class="state state-empty">
      <span class="state-icon" aria-hidden="true">
        <Icon />
      </span>
      <p>{text}</p>
      {action && (
        <button class="btn btn-ghost btn-sm" onClick={action.onClick}>
          {action.label}
        </button>
      )}
    </div>
  );
}

/**
 * Пустой поиск — отдельно от пустого списка: причина разная, и действие тоже.
 *
 * Никаких «0 результатов» — это сообщение про счётчик, а не про человека. Вместо
 * счётчика до трёх подсказок: что попробовать вместо запроса.
 */
export function EmptySearch({
  query,
  hints = [],
  onReset,
}: {
  query: string;
  hints?: string[];
  onReset?: () => void;
}) {
  return (
    <div class="state state-empty">
      <span class="state-icon" aria-hidden="true">
        <IconSearch />
      </span>
      <p>
        По запросу «{query}» ничего нет
      </p>
      {hints.length > 0 && (
        <ul class="state-hints">
          {hints.slice(0, 3).map((h) => (
            <li key={h}>{h}</li>
          ))}
        </ul>
      )}
      {onReset && (
        <button class="btn btn-ghost btn-sm" onClick={onReset}>
          Сбросить поиск
        </button>
      )}
    </div>
  );
}

/**
 * Ошибка первой загрузки: список пуст, показывать нечего.
 *
 * `role="alert"` — потому что блок появляется после того, как страница уже
 * прочитана: без него скринридер об ошибке не узнает. Красная рамка идёт вместе
 * с иконкой и словом «Ошибка»: цветом одним смысл передавать нельзя (WCAG
 * 1.4.1), да и на монохромном экране рамка просто исчезает.
 */
export function ErrorState({
  text = "Не загрузилось. Возможно, шалит сеть",
  onRetry,
}: {
  text?: string;
  onRetry?: () => void;
}) {
  return (
    <div class="state state-error" role="alert">
      <p class="state-error-head">
        <span class="state-icon" aria-hidden="true">
          <IconAlertTriangle />
        </span>
        Ошибка
      </p>
      <p>{text}</p>
      {onRetry && (
        <button class="btn btn-ghost btn-sm" onClick={onRetry}>
          <IconRotateCw /> Повторить
        </button>
      )}
    </div>
  );
}

/**
 * Ошибка догрузки следующей страницы — строка в хвосте списка, а не баннер.
 *
 * Загруженное остаётся на экране и остаётся читаемым: подменять его коробкой
 * «не загрузилось» значит наказывать за то, что человек долистал до конца.
 * `role="status"`, а не `alert`: ничего не потеряно, читать можно дальше.
 */
export function ErrorMoreRow({
  text = "Дальше не подгрузилось",
  onRetry,
}: {
  text?: string;
  onRetry: () => void;
}) {
  return (
    <div class="state-more" role="status">
      <span class="state-icon" aria-hidden="true">
        <IconAlertTriangle />
      </span>
      <span>{text}</span>
      <button class="btn btn-ghost btn-sm" onClick={onRetry}>
        <IconRotateCw /> Повторить
      </button>
    </div>
  );
}

/**
 * 404 на детальной — настоящая страница с `h1`, а не коробка состояния.
 *
 * Коробка внутри пустой страницы оставляла документ без первого заголовка:
 * скринридер и поисковик начинали чтение со второго уровня. Здесь же и выход —
 * ссылка в раздел, из которого пришли, а не только «на главную».
 */
export function NotFoundState({
  title = "Страница не найдена",
  text,
  backHref = "/",
  backLabel = "На главную",
}: {
  title?: string;
  text: string;
  backHref?: string;
  backLabel?: string;
}) {
  return (
    <div class="state state-404">
      <span class="state-icon state-icon-lg" aria-hidden="true">
        <IconCircleSlash />
      </span>
      <h1>{title}</h1>
      <p>{text}</p>
      <a class="btn btn-ghost btn-sm" href={backHref}>
        {backLabel}
      </a>
    </div>
  );
}
