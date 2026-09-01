// boot-probe ДОЛЖЕН идти первым: он лист графа зависимостей и потому
// выполняется раньше всего остального бандла — это и есть первая ступень
// лестницы. Вызов, стоявший здесь statement'ом выше блока import, не
// выполнялся раньше импортов никогда: import — декларация (см. boot-probe.ts).
import { debug } from "./boot-probe";
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import ErrorBoundary from "./components/ErrorBoundary";
import "./styles.css";
import { initTelegramTheme } from "./lib/theme";

debug("imports ok, mounting…");

try {
  initTelegramTheme();
} catch {}

try {
  const root = document.getElementById("root");
  if (!root) throw new Error("#root not found");
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </React.StrictMode>,
  );
  debug("react mounted");
  setTimeout(() => {
    const el = document.getElementById("boot-err");
    if (el && el.textContent?.startsWith("[boot]")) el.remove();
    const sp = document.getElementById("boot-splash");
    if (sp) sp.remove();
  }, 800);
} catch (e: any) {
  console.error("[miniapp] mount error", e);
  debug("Не удалось запустить интерфейс. Перезагрузите панель.");
  const el = document.getElementById("boot-err");
  if (el) el.style.background = "#c0392b";
}
