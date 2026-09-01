import { PulsePanel } from "./PulsePanel";
import { IconTelegram, IconArrowRight } from "../components/icons";
import { CHANNEL_URL } from "../config";

/**
 * Hero — асимметричная пара: текст слева, живые цифры справа.
 *
 * До редизайна это был центрированный столбец текста поверх градиентного
 * пятна, а сводка висела отдельной плашкой ниже. Пара «обещание + доказательство
 * рядом» — то, ради чего сводка вообще существует.
 */
export function HomeHero() {
  return (
    <section class="hero">
      <div class="hero-copy">
        <p class="hero-eyebrow">Крипта и AI · регулярно · по-русски</p>
        <h1 class="hero-title">
          Что происходит в <span class="grad">крипте и AI</span> — за пару минут
        </h1>
        <p class="hero-sub">
          Дайджесты вместо сотни Telegram-каналов, календарь разблокировок
          токенов и живые дропы. Открыл — прочитал — в курсе.
        </p>
        <div class="hero-actions">
          <a
            class="btn btn-primary"
            href={CHANNEL_URL}
            target="_blank"
            rel="noopener noreferrer"
          >
            <IconTelegram /> Читать в Telegram
          </a>
          <a class="btn btn-ghost" href="/digests">
            Свежие дайджесты <IconArrowRight />
          </a>
        </div>
        <p class="hero-trust">
          Без кошелька, сид-фраз и подписей. Подключать ничего не нужно — мы
          только читаем и собираем. Бесплатно, без регистрации.
        </p>
      </div>
      <PulsePanel />
    </section>
  );
}
