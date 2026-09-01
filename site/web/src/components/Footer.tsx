import { IconTelegram } from "./icons";
import { CHANNEL_URL } from "../config";

export function Footer() {
  return (
    <footer class="site-footer">
      <div class="container footer-inner">
        <span class="footer-copy">© 2026 DeLabs · крипта и AI без шума</span>
        <nav class="footer-nav">
          <a class="footer-link" href="/digests">Дайджесты</a>
          <a class="footer-link" href="/unlocks">Разблокировки</a>
          <a class="footer-link" href="/drops">Дропы</a>
          <a class="footer-link" href="/about">О проекте</a>
          {/* target обязателен, и это не про новую вкладку. `/rss.xml` отдаёт
              сервер, но адрес начинается со слэша — значит клик перехватывал
              preact-router, отменял настоящий переход и рисовал свою же
              страницу «не найдено» поверх работающей ленты. Router пропускает
              ссылку только если у неё есть target. */}
          <a class="footer-link" href="/rss.xml" target="_blank" rel="noopener">
            RSS
          </a>
        </nav>
        <a
          class="footer-link"
          href={CHANNEL_URL}
          target="_blank"
          rel="noopener noreferrer"
        >
          <IconTelegram size={16} /> Канал в Telegram
        </a>
      </div>
      <div class="container">
        <p class="footer-disclaimer">
          DeLabs — информационный проект. Ничто на сайте не является
          финансовой рекомендацией. Проверяйте данные и принимайте решения сами.
        </p>
      </div>
    </footer>
  );
}
