import { useEffect, useMemo, useState } from "react";
import { api, formatApiError } from "../lib/api";
import { SkeletonList } from "../components/Skeleton";
import { EmptyState } from "../components/EmptyState";
import { ErrorBox } from "../components/ErrorBox";
import { useLatestRun } from "../lib/stale";

interface PageRef {
  scope: string;
  slug: string;
  title: string;
}

/** Wiki-вью (P1 2026-06-09): список страниц памяти агентов + просмотр markdown. */
export default function Wiki() {
  const [pages, setPages] = useState<PageRef[]>([]);
  const [scope, setScope] = useState("");
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const [truncated, setTruncated] = useState(false);
  // Приходит с сервера и считается по всей вике: раздел, чьи страницы не
  // влезли в выдачу, обязан остаться в списке — иначе до них не добраться.
  const [scopes, setScopes] = useState<string[]>([]);

  // Открытая страница.
  const [open, setOpen] = useState<PageRef | null>(null);
  const [content, setContent] = useState<string>("");
  const [pageLoading, setPageLoading] = useState(false);
  const [pageErr, setPageErr] = useState<string | null>(null);
  // 403 — это не сбой, а ответ по существу: список открыт всем из allowlist,
  // тело страницы — только админу. Показывать его через ErrorBox с кнопкой
  // «Повторить» значит предлагать человеку долбиться в закрытую дверь.
  const [pageDenied, setPageDenied] = useState(false);

  // Раздел — серверный фильтр, а не клиентский.
  //
  // Аудит 2026-08-21: список запрашивался без scope, а фильтровался по нему на
  // клиенте. Сервер режет выдачу по 500 (WIKI_LIST_MAX) ПОСЛЕ применения
  // scope, то есть параметр сужал выборку до потолка, а не после него.
  // Замер: 600 страниц в `_team` и по три в `qa` и `smm` — клиент получает
  // 500 страниц одного `_team`, страниц `qa` не показывает ни одной, а
  // подсказка «уточни раздел» советует то, что ничего не меняло: выбор
  // раздела фильтровал те же 500. Самого раздела `qa` в списке при этом тоже
  // не было — он строился из обрезанной выдачи.
  const beginLoad = useLatestRun();

  async function loadList(forScope: string) {
    const isCurrent = beginLoad();
    setLoading(true);
    setErr(null);
    try {
      const r = await api.wikiList(forScope || undefined);
      if (!isCurrent()) return;
      setPages(r.pages);
      setTruncated(Boolean(r.truncated));
      if (r.scopes) setScopes(r.scopes);
    } catch (e: any) {
      if (!isCurrent()) return;
      setErr(formatApiError(e));
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }

  useEffect(() => {
    loadList(scope);
  }, [scope]);

  // Reader-вью рисует шапку из `open`, а тело из `content`. Открыли страницу A,
  // вернулись, открыли B — ответ по A приходит вторым и кладёт свой текст под
  // заголовок B. Вики это память агентов: чужой текст под правильным именем
  // хуже, чем пустая страница.
  const beginOpen = useLatestRun();

  async function openPage(p: PageRef) {
    const isCurrent = beginOpen();
    setOpen(p);
    setPageLoading(true);
    setPageErr(null);
    setPageDenied(false);
    setContent("");
    try {
      const r = await api.wikiPage(p.scope, p.slug);
      if (!isCurrent()) return;
      setContent(r.content);
    } catch (e: any) {
      if (!isCurrent()) return;
      if (e?.status === 403) setPageDenied(true);
      else setPageErr(formatApiError(e));
    } finally {
      // Устаревший запрос не гасит индикатор: актуальный ещё в пути.
      if (isCurrent()) setPageLoading(false);
    }
  }

  const visible = useMemo(() => {
    const qn = q.trim().toLowerCase();
    return pages.filter((p) => {
      if (!qn) return true;
      return (
        p.title.toLowerCase().includes(qn) ||
        p.slug.toLowerCase().includes(qn)
      );
    });
  }, [pages, q]);

  // Reader-вью открытой страницы.
  if (open) {
    return (
      <div>
        <div className="btn-row" style={{ marginBottom: 10 }}>
          <button className="btn secondary" onClick={() => setOpen(null)}>
            ← Назад к списку
          </button>
          <button
            className="btn secondary"
            disabled={pageLoading}
            onClick={() => openPage(open)}
            style={{ marginLeft: "auto" }}
          >
            ⟳ Обновить
          </button>
        </div>
        <div className="meta" style={{ marginBottom: 8 }}>
          <span className="badge">{open.scope}</span> {open.slug}
        </div>
        <ErrorBox message={pageErr} onRetry={() => openPage(open)} />
        {pageLoading ? (
          <SkeletonList rows={6} />
        ) : pageDenied ? (
          <EmptyState
            icon="🔒"
            title="Содержимое доступно администратору"
            hint="Страницы вики агенты пишут сами, без подтверждения человеком, поэтому тело страницы видно только в админском доступе. Заголовок и раздел — выше."
          />
        ) : (
          <pre
            style={{
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              fontSize: 13,
              lineHeight: 1.5,
              background: "var(--card, #1c1c1e)",
              padding: 12,
              borderRadius: 8,
              margin: 0,
            }}
          >
            {content}
          </pre>
        )}
      </div>
    );
  }

  return (
    <div>
      <ErrorBox message={err} onRetry={() => loadList(scope)} />
      <div className="filter-row">
        <div style={{ display: "flex", flexDirection: "column", flex: 1 }}>
          <label
            htmlFor="wiki-search"
            style={{ fontSize: 12, color: "var(--hint)", marginBottom: 4 }}
          >
            Поиск по заголовкам
          </label>
          <input
            id="wiki-search"
            placeholder="Поиск…"
            value={q}
            onChange={(e) => setQ(e.currentTarget.value)}
            role="search"
            aria-label="Поиск по страницам вики"
          />
        </div>
        <div style={{ display: "flex", flexDirection: "column", flex: 1 }}>
          <label
            htmlFor="wiki-scope"
            style={{ fontSize: 12, color: "var(--hint)", marginBottom: 4 }}
          >
            Раздел
          </label>
          <select
            id="wiki-scope"
            value={scope}
            onChange={(e) => setScope(e.currentTarget.value)}
          >
            <option value="">все разделы</option>
            {scopes.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
      </div>

      {truncated && !loading && (
        <div className="meta" style={{ marginBottom: 8 }}>
          {scope
            ? "Показаны не все страницы раздела — выдача обрезана по лимиту. Уточни поиск."
            : "Показаны не все страницы — выдача обрезана по лимиту. Выбери раздел."}
        </div>
      )}

      {loading ? (
        <SkeletonList rows={6} />
      ) : visible.length === 0 ? (
        <EmptyState
          icon="📖"
          title="Страниц нет"
          hint={
            q || scope
              ? "Попробуй сбросить фильтр."
              : "Агенты ещё не записали ни одной страницы в вики."
          }
        />
      ) : (
        visible.map((p) => (
          <button
            type="button"
            className="list-item"
            key={`${p.scope}/${p.slug}`}
            onClick={() => openPage(p)}
            style={{
              width: "100%",
              textAlign: "left",
              cursor: "pointer",
              background: "none",
              border: "none",
            }}
          >
            <div style={{ minWidth: 0, flex: 1 }}>
              <div className="title">{p.title || p.slug}</div>
              <div className="meta">{p.slug}</div>
            </div>
            <span className="badge">{p.scope}</span>
          </button>
        ))
      )}
    </div>
  );
}
