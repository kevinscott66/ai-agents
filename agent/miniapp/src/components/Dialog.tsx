/**
 * Доступное модальное окно (AUD-013).
 *
 * До него модалки Mini App были просто div поверх страницы: без role=dialog и
 * aria-modal скринридер читал страницу под ними, Tab уходил за оверлей, Escape
 * ничего не делал, а после закрытия фокус падал в начало документа.
 *
 * Здесь: role=dialog + aria-modal + aria-labelledby на заголовок; фокус при
 * открытии — на первый интерактивный элемент (или сам контейнер); Tab и
 * Shift+Tab ходят по кругу внутри; Escape и клик по оверлею закрывают, если
 * закрытие не запрещено (`closeDisabled` — например, пока идёт отправка);
 * после закрытия фокус возвращается туда, откуда диалог открыли.
 */
import { useEffect, useRef, type ReactNode } from "react";
import { FOCUSABLE, trapTarget } from "../lib/focus-trap";

let seq = 0;

export function Dialog({
  title,
  onClose,
  closeDisabled = false,
  children,
}: {
  title: ReactNode;
  onClose: () => void;
  closeDisabled?: boolean;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useRef(`dialog-title-${++seq}`).current;
  // Свежие значения для обработчика, навешанного один раз.
  const closeRef = useRef({ onClose, closeDisabled });
  closeRef.current = { onClose, closeDisabled };

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const box = ref.current;
    const first = box?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? box)?.focus();
    return () => {
      // Открывший элемент мог исчезнуть (задача выпала из фильтра) — тогда
      // фокус остаётся браузеру, а не падает в отсоединённый узел.
      if (opener && opener.isConnected) opener.focus();
    };
  }, []);

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.stopPropagation();
      if (!closeRef.current.closeDisabled) closeRef.current.onClose();
      return;
    }
    if (e.key !== "Tab" || !ref.current) return;
    const items = Array.from(ref.current.querySelectorAll<HTMLElement>(FOCUSABLE));
    const target = trapTarget(items.length, items.indexOf(document.activeElement as HTMLElement), e.shiftKey);
    if (target === null) return;
    e.preventDefault();
    (target < 0 ? ref.current : items[target]).focus();
  }

  return (
    <div
      className="modal-overlay"
      onClick={() => {
        if (!closeDisabled) onClose();
      }}
    >
      <div
        ref={ref}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown as never}
      >
        <h2 id={titleId}>{title}</h2>
        {children}
      </div>
    </div>
  );
}
