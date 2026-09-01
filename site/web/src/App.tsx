import { useErrorBoundary, useRef, useState } from "preact/hooks";
import type { ComponentChildren } from "preact";
import Router, { type RouterOnChangeArgs } from "preact-router";
import { currentSafeUrl } from "./url";
import { markNavigation, scrollForNavigation } from "./nav";
import { Header } from "./components/Header";
import { Footer } from "./components/Footer";
import { HomePage } from "./pages/HomePage";
import { DigestPage } from "./pages/DigestPage";
import { DigestsPage } from "./pages/DigestsPage";
import { UnlocksPage } from "./pages/UnlocksPage";
import { DropsPage } from "./pages/DropsPage";
import { ActivitiesPage } from "./pages/ActivitiesPage";
import { ActivityPage } from "./pages/ActivityPage";
import { AboutPage } from "./pages/AboutPage";
import { StatusPage } from "./pages/StatusPage";
import { ErrorState, NotFoundState } from "./components/states";

export function App() {
  const [url, setUrl] = useState<string>(
    typeof window !== "undefined" ? window.location.pathname : "/",
  );

  const contentRef = useRef<HTMLDivElement | null>(null);

  const onChange = (e: RouterOnChangeArgs) => {
    setUrl(e.url);
    // Единственное место, где адрес меняется, — отсюда `goBackOr` и узнаёт,
    // ходили ли мы уже внутри сайта (см. nav.ts).
    /* Безусловный scrollTo(0) стоял здесь на ЛЮБОЙ смене адреса и затирал
       восстановление положения, которое браузер делает сам при «Назад» и после
       F5: человек, отмотавший ленту до середины и открывший карточку, по
       «Назад» возвращался в начало и мотал заново. Условие — в nav.ts, под
       тестом. */
    scrollForNavigation(markNavigation());
    /* Скролл наверх переносил взгляд, но не фокус: у пользователя клавиатуры
       следующий Tab продолжал со ссылки на прежней странице, а скринридер
       вообще не узнавал, что страница сменилась. preventScroll — потому что
       позицию уже задал scrollTo выше. */
    contentRef.current?.focus({ preventScroll: true });
  };

  return (
    <div class="app">
      {/* Первый в порядке табуляции: даёт пропустить шапку и уйти сразу в
          контент. Виден только когда получает фокус. */}
      <a
        class="skip-link"
        href="#content"
        onClick={(e) => {
          e.preventDefault();
          contentRef.current?.focus();
        }}
      >
        К содержимому
      </a>
      <Header url={url} />
      <div id="content" tabIndex={-1} ref={contentRef} class="app-content">
        <Boundary>
          {/* url — уже безопасный: preact-router декодирует сегменты и query
              без try/catch, и битый percent-escape ронял render целиком (см.
              url.ts). Boundary — страховка на то же для переходов «назад». */}
          <Router url={currentSafeUrl()} onChange={onChange}>
            <HomePage path="/" />
            <DigestsPage path="/digests" />
            <UnlocksPage path="/unlocks" />
            <DropsPage path="/drops" />
            <ActivitiesPage path="/activities" />
            <StatusPage path="/status" />
            <AboutPage path="/about" />
            <DigestPage path="/digest/:id" />
            <ActivityPage path="/activity/:id" />
            <NotFound default />
          </Router>
        </Boundary>
      </div>
      <Footer />
    </div>
  );
}

/**
 * Граница ошибок вокруг роутера. Без неё любой бросок в render оставлял
 * пустую страницу: `render(<App />, root)` вызывается один раз, ловить
 * исключение некому. Шапка и подвал остаются на месте — уйти со страницы
 * можно обычной ссылкой.
 */
function Boundary({ children }: { children: ComponentChildren }) {
  const [error] = useErrorBoundary((e) =>
    console.error("[app] render failed", e),
  );
  if (!error) return <>{children}</>;
  return (
    <main class="container">
      {/* Перезагрузка, а не «на главную»: до этого места доходят только сбои
          рендера, и та же страница после reload обычно открывается. */}
      <ErrorState
        text="Страница не открылась. Обычно помогает перезагрузка; если нет — вернитесь назад."
        onRetry={() => window.location.reload()}
      />
    </main>
  );
}

function NotFound(_: { default?: boolean }) {
  return (
    <main class="container">
      <NotFoundState text="Такого адреса на сайте нет. Возможно, ссылка устарела или в ней опечатка." />
    </main>
  );
}
