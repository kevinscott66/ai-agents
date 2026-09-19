/**
 * DOM для поведенческих тестов Mini App (AUD-029).
 *
 * Регрессии Mini App долго проверяли текст исходников: «в Tasks.tsx есть
 * role="dialog"». Такой тест проходит, даже если фокус в диалог не попадает.
 * Здесь настоящий рендер Preact в happy-dom: клики, клавиши, фокус.
 *
 * happy-dom ставится глобально (window/document) только на время файла:
 * `installDom()` на верхнем уровне, до импорта компонентов (Preact при загрузке
 * смотрит, есть ли requestAnimationFrame), `uninstallDom()` в afterAll —
 * следующие файлы в том же процессе DOM не видят.
 */
import { GlobalRegistrator } from "@happy-dom/global-registrator";

export function installDom(): void {
  if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register({ url: "https://miniapp.test/" });
}

export async function uninstallDom(): Promise<void> {
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
}

/** Дать отработать эффектам Preact и ответам подменённого fetch. */
export async function settle(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0));
}

/**
 * Ждать условия, а не «N тиков». useEffect в Preact срабатывает после
 * отрисовки: через requestAnimationFrame, а если preact/hooks загрузился
 * раньше DOM (другой файл в том же процессе) — через запасной таймер 35 мс.
 * Фиксированное число тиков тогда не успевает.
 */
export async function waitFor(check: () => boolean, what: string, timeoutMs = 2000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > until) throw new Error(`не дождались: ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

export function key(target: Element | Document, k: string, shift = false): void {
  target.dispatchEvent(new KeyboardEvent("keydown", { key: k, shiftKey: shift, bubbles: true, cancelable: true }));
}

/** Ввод как у пользователя: значение и событие input (Preact слушает onInput/onChange). */
export function type(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

export function button(root: ParentNode, text: string): HTMLButtonElement {
  const found = Array.from(root.querySelectorAll("button")).find((b) => (b.textContent ?? "").includes(text));
  if (!found) throw new Error(`нет кнопки «${text}»`);
  return found as HTMLButtonElement;
}
