// Переиспользуемые чипы-фильтры (тёмная неон-тема, как у бейджей).
// Доступность: role="group" + aria-pressed на активном чипе.

interface FilterChipsProps<T extends string> {
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  ariaLabel: string;
}

export function FilterChips<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
}: FilterChipsProps<T>) {
  return (
    <div class="chips" role="group" aria-label={ariaLabel}>
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            class={`chip${active ? " chip-active" : ""}`}
            aria-pressed={active}
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
