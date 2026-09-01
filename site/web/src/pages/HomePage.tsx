import { HomeHero } from "../home/HomeHero";
import { HomeDigests } from "../home/HomeDigests";
import { HomeUnlocks } from "../home/HomeUnlocks";
import { HomeDrops } from "../home/HomeDrops";
import { HomeActivities } from "../home/HomeActivities";
import { IconTelegram, IconArrowRight } from "../components/icons";
import { CHANNEL_URL } from "../config";

/**
 * Главная. Раньше это были четыре одинаковых блока «шапка + сетка карточек»
 * подряд — один ритм и один вес для четырёх разных по смыслу данных, отчего
 * страница читалась как шаблон. Теперь у каждого типа своя форма: передовица
 * для дайджестов, ось времени для разблокировок, табло для дропов, лента для
 * гайдов. Страницы разделов остались списками — там задача обратная.
 */
export function HomePage(_: { path?: string }) {
  return (
    <main class="container page-home">
      <HomeHero />
      <HomeDigests />
      <HomeUnlocks />
      <HomeDrops />
      <HomeActivities />

      <section class="section closing">
        <h2 class="closing-title">Один экран вместо десятка вкладок</h2>
        <p class="closing-text">
          DeLabs собирает дайджесты по крипте и AI, календарь разблокировок
          токенов и ленту активных дропов — всё со ссылками на первоисточники.
        </p>
        <div class="closing-actions">
          <a
            class="btn btn-primary"
            href={CHANNEL_URL}
            target="_blank"
            rel="noopener noreferrer"
          >
            <IconTelegram /> Читать в Telegram
          </a>
          <a class="btn btn-ghost" href="/about">
            О проекте <IconArrowRight />
          </a>
        </div>
      </section>
    </main>
  );
}
