import { SectionHead } from "../components/states";

type ProjectStatus = {
  name: string;
  state: string;
  badge: string;
  badgeClass: string;
  summary: string;
  checks: string[];
  next: string;
};

const PROJECTS: ProjectStatus[] = [
  {
    name: "Kom / Telegram bot",
    state: "Код готов",
    badge: "Локально проверено",
    badgeClass: "badge-status-ok",
    summary:
      "Backend и collaboration Mini App проходят локальные тесты, typecheck и security-проверки.",
    checks: [
      "Backend: 3195 pass, 4 skip, 0 fail",
      "Mini App: 215 pass, typecheck и build зелёные",
      "Публикация в Telegram требует human approval",
    ],
    next: "Остались merge в main, deploy и live-проверка DNS, Lead-панели и Telegram-сессии.",
  },
  {
    name: "Android",
    state: "В работе",
    badge: "Release не завершён",
    badgeClass: "badge-status-soon",
    summary:
      "Контракты, typecheck, auth-сценарии и native release build проходят локально.",
    checks: [
      "App-core auth: 36/36 pass в разрешённом окружении",
      "Android contract: 7/7 pass",
      "APK собирается, но ещё не подписан",
    ],
    next: "Нужны keystore, подписанный APK и smoke-тест на реальном устройстве или эмуляторе.",
  },
  {
    name: "ВахтаХоз",
    state: "Готов к live-проверке",
    badge: "Production не подтверждён",
    badgeClass: "badge-status-soon",
    summary:
      "Локальные Edge Functions, recovery/auth-логика и security-проверки проходят.",
    checks: [
      "Тесты: 23/23 pass",
      "Edge Functions build проходит",
      "Rate limits и recovery-защита проверены локально",
    ],
    next: "Нужно подтвердить live Supabase Functions, миграции, RLS, Auth и почтовый recovery flow.",
  },
];

export function StatusPage(_: { path?: string }) {
  return (
    <main class="container page-section">
      <section class="section">
        <SectionHead
          title="Статус проектов"
          sub="Снимок локальных проверок на 23 августа 2026 года. Production-гейты отмечены отдельно."
        />

        <div class="cards">
          {PROJECTS.map((project) => (
            <article class="card" key={project.name}>
              <div class="card-meta">
                <span class="card-meta-date">Проект</span>
                <span class={`badge ${project.badgeClass}`}>{project.badge}</span>
              </div>
              <h2 class="card-title">{project.name}</h2>
              <p class="card-summary">{project.summary}</p>
              <ul class="status-points">
                {project.checks.map((check) => (
                  <li key={check}>{check}</li>
                ))}
              </ul>
              <p class="status-next">
                <strong>{project.state}.</strong> {project.next}
              </p>
            </article>
          ))}
        </div>

        <p class="status-note">
          Локальные тесты не заменяют проверку production. Мы не считаем проект
          доступным пользователям, пока не подтверждены deploy, DNS, live API и
          пользовательский сценарий.
        </p>
      </section>
    </main>
  );
}
