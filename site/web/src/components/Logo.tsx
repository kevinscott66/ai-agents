/**
 * Лого DeLabs: знак-пульс + текст-вордмарк.
 *
 * Знак был растром — `/logo.png`, 57 КБ, синий объёмный «D» с бликом. Его
 * рисовали до редизайна, и в шапке он остался единственным местом, где ещё жил
 * старый сине-фиолетовый бренд: прямо слева от бирюзового вордмарка, на каждой
 * странице. Плюс 57 КБ на запрос ради иконки 28×28 и мыло на retina.
 *
 * Теперь та же геометрия, что в `public/favicon.svg`, инлайном: резко на любом
 * размере, нисколько не весит и не может разъехаться с иконкой вкладки —
 * расходиться просто нечему, кроме этих двух файлов.
 *
 * `aria-hidden`: следом идёт тот же текст «DeLabs», и без этого скринридер
 * читал бы название дважды подряд.
 */
export function Logo({ size = 28 }: { size?: number }) {
  return (
    <span class="logo">
      <svg
        class="logo-img"
        width={size}
        height={size}
        viewBox="0 0 40 40"
        fill="none"
        aria-hidden="true"
      >
        <rect width="40" height="40" rx="9" fill="#0b1020" />
        <circle
          cx="20"
          cy="20"
          r="15.5"
          stroke="var(--accent)"
          stroke-width="2"
          opacity="0.3"
        />
        <path
          d="M5 21 H13 L16 12 L21 28 L24.5 19 L27 21 H35"
          stroke="var(--accent)"
          stroke-width="2.8"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
      <span class="logo-text">
        De<span class="logo-accent">Labs</span>
      </span>
    </span>
  );
}
