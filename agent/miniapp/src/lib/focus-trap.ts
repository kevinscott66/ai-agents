/**
 * Ловушка фокуса для модальных окон (AUD-013). Чистая логика отдельно от
 * компонента — чтобы проверять её без DOM.
 */
export const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Куда уводить фокус на Tab. null — браузер справится сам (фокус не на краю).
 * `current` = -1: фокус вне диалога (например, на самом контейнере).
 */
export function trapTarget(count: number, current: number, shift: boolean): number | null {
  if (count === 0) return -1; // некуда — держим на контейнере
  if (current < 0) return shift ? count - 1 : 0;
  if (shift && current === 0) return count - 1;
  if (!shift && current === count - 1) return 0;
  return null;
}
