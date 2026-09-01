import { useEffect, useRef, useState } from "preact/hooks";
import { Logo } from "./Logo";
import { IconTelegram } from "./icons";
import { CHANNEL_URL } from "../config";
import { opensElsewhere, sectionPath, swallowsNavClick } from "../nav";

/**
 * Ниже этой ширины навигация — выдвижной ящик, выше — обычная строка в шапке.
 * Держится в паре с `@media (max-width: 880px)` в `styles.css`: если менять,
 * менять оба места, иначе меню останется открытым там, где его уже не видно.
 */
const NAV_DRAWER_MAX_WIDTH = 880;

const NAV = [
  { href: "/digests", label: "Дайджесты" },
  { href: "/unlocks", label: "Разблокировки" },
  { href: "/drops", label: "Дропы" },
  { href: "/activities", label: "Активности" },
  { href: "/status", label: "Статус проектов" },
  { href: "/about", label: "О проекте" },
];

export function Header({ url }: { url: string }) {
  const path = sectionPath(url);
  const [open, setOpen] = useState(false);
  const navRef = useRef<HTMLElement | null>(null);
  const toggleRef = useRef<HTMLButtonElement | null>(null);

  const close = (returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) toggleRef.current?.focus();
  };

  /**
   * По клику на пункт меню нужно только закрыть ящик. Переход делает сам
   * preact-router.
   *
   * Здесь стояли `e.preventDefault()` + `route(href)`, и это давало ДВА
   * перехода на один клик: preventDefault не останавливает всплытие, а
   * router слушает клик на window и `defaultPrevented` не проверяет — то
   * есть вызывал `route()` вторым. Каждый вызов делает свой pushState, в
   * историю ложились две записи, и первое нажатие «назад» возвращало на ту
   * же самую страницу. Ссылки в подвале и в карточках onClick не имеют и
   * всегда работали правильно — из-за этого поведение шапки читалось не как
   * приём, а как сломанная кнопка браузера.
   */
  const closeMenu = (e: MouseEvent) => {
    if (opensElsewhere(e)) return;
    close(false);
  };

  /**
   * Клик по пункту меню. Если это наш же раздел — перехода не делаем.
   *
   * Почему обеими руками: `preventDefault` отменяет только переход браузера по
   * href. Роутер слушает клик на `window` и `defaultPrevented` не проверяет —
   * его останавливает единственно `stopPropagation`. Убери любую из двух строк,
   * и клик снова положит в историю запись, которую некому пометить (почему это
   * плохо — в докблоке `swallowsNavClick`).
   *
   * Наверх уводим сами: нажать «Дропы», стоя внизу списка дропов, — это просьба
   * вернуться к его началу, и раньше её выполнял перезапуск секции.
   */
  const navClick = (e: MouseEvent, href: string) => {
    if (swallowsNavClick(e, url, href)) {
      e.preventDefault();
      e.stopPropagation();
      window.scrollTo({ top: 0 });
    }
    closeMenu(e);
  };

  /**
   * Открытый ящик меню — модальный слой: пока он открыт, Escape закрывает его и
   * возвращает фокус на бургер, а Tab не выпускает фокус наружу. Без ловушки
   * следующий Tab уходил в контент под затемнением — на экране ничего не
   * подсвечивалось, и пользователь клавиатуры терял место.
   */
  useEffect(() => {
    if (!open) return;

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close(true);
        return;
      }
      if (e.key !== "Tab") return;

      const nav = navRef.current;
      const toggle = toggleRef.current;
      if (!nav || !toggle) return;

      const items = [
        toggle,
        ...Array.from(
          nav.querySelectorAll<HTMLElement>("a[href], button:not([disabled])"),
        ),
      ].filter((el) => el.offsetParent !== null || el === toggle);
      if (items.length === 0) return;

      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement as HTMLElement | null;

      if (e.shiftKey && (active === first || !items.includes(active as HTMLElement))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKey);
    // Фон не должен уезжать под открытым листом меню.
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    /**
     * Ящик существует только под 880px. Если окно расширили или планшет
     * повернули с открытым меню, вёрстка возвращает навигацию в строку шапки, а
     * состояние `open` остаётся — вместе с `overflow: hidden` на body и
     * затемнением поверх страницы. Получался экран, который нечем закрыть:
     * бургер скрыт медиазапросом, а страница не прокручивается.
     */
    const wide = window.matchMedia(`(min-width: ${NAV_DRAWER_MAX_WIDTH + 1}px)`);
    const onWiden = (e: MediaQueryListEvent) => {
      // Фокус на бургер не возвращаем: на этой ширине его уже нет на экране.
      if (e.matches) close(false);
    };
    wide.addEventListener("change", onWiden);

    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
      wide.removeEventListener("change", onWiden);
    };
  }, [open]);

  return (
    <>
      {/* Затемнение — часть модального поведения: клик мимо закрывает.
          aria-hidden, потому что это не элемент управления для скринридера:
          у него Escape и сама навигация.
          Лежит СНАРУЖИ <header> намеренно: у шапки backdrop-filter, а он
          создаёт содержащий блок для position: fixed — внутри неё inset: 0
          растянулся бы по 64px шапки, а не по экрану. Плюс z-index 8 против
          50 у шапки даёт нужный порядок: затемнение поверх страницы, но под
          самим меню. */}
      {open && (
        <div class="nav-scrim" aria-hidden="true" onClick={() => close(false)} />
      )}
      <header class="site-header">
        <div class="container header-inner">
          <a class="header-logo" href="/" onClick={(e) => navClick(e, "/")}>
            <Logo />
          </a>

          <button
            ref={toggleRef}
            type="button"
            class={`nav-toggle ${open ? "is-open" : ""}`}
            aria-label={open ? "Закрыть меню" : "Открыть меню"}
            aria-expanded={open}
            aria-controls="site-nav"
            onClick={() => setOpen((v) => !v)}
          >
            <span />
            <span />
            <span />
          </button>

          <nav
            id="site-nav"
            ref={navRef}
            class={`site-nav ${open ? "open" : ""}`}
            aria-label="Основная навигация"
          >
            {NAV.map((n) => {
              const active = path === n.href;
              return (
                <a
                  key={n.href}
                  href={n.href}
                  class={active ? "is-active" : ""}
                  aria-current={active ? "page" : undefined}
                  onClick={(e) => navClick(e, n.href)}
                >
                  {n.label}
                </a>
              );
            })}
            {/* Ghost, а не заливка: залитая primary-кнопка принадлежит странице и
                должна быть на ней одна. В шапке она конкурировала с главным
                действием каждой страницы. */}
            <a
              class="btn btn-ghost btn-cta"
              href={CHANNEL_URL}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => close(false)}
            >
              <IconTelegram /> В Telegram
            </a>
          </nav>
        </div>
      </header>
    </>
  );
}
