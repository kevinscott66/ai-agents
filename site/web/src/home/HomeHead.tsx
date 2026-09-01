import { IconArrowRight } from "../components/icons";

/**
 * Шапка блока главной: заголовок слева, ссылка «всё» справа, тонкая линейка
 * снизу. Отличается от `SectionHead` на страницах разделов намеренно — там
 * шапка вводит страницу, здесь она делит поток и сразу отдаёт выход в раздел,
 * без отдельной кнопки по центру под каждым блоком.
 *
 * Подзаголовок необязателен: он нужен там, где данные требуют пояснения
 * (откуда цифры), и лишний там, где строки говорят сами за себя.
 */
export function HomeHead({
  title,
  sub,
  href,
  linkLabel,
}: {
  title: string;
  sub?: string;
  href: string;
  linkLabel: string;
}) {
  return (
    <header class="hhead">
      <h2 class="hhead-title">{title}</h2>
      <a class="hhead-link" href={href}>
        {linkLabel} <IconArrowRight size={15} />
      </a>
      {sub && <p class="hhead-sub">{sub}</p>}
    </header>
  );
}
