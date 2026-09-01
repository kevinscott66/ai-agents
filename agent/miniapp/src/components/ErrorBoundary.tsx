/**
 * M4 — top-level error boundary.
 *
 * Catches render errors anywhere below it and renders a friendly card with
 * a "Reload" button. Preact-compatible class component (Preact exposes the
 * React-compatible Component class via the "react" alias configured in
 * vite.config.ts).
 */
import { Component, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: unknown): void {
    // eslint-disable-next-line no-console
    console.error("[miniapp] render error:", error, info);
  }

  reload = () => {
    try {
      window.location.reload();
    } catch {}
  };

  render() {
    if (this.state.error) {
      return (
        <div
          style={{
            padding: 16,
            margin: 16,
            border: "1px solid #c0392b",
            borderRadius: 8,
            background: "#fdecea",
            color: "#611a15",
            fontFamily: "system-ui, sans-serif",
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: 8 }}>
            Что-то пошло не так
          </div>
          <div style={{ fontSize: 13, opacity: 0.85, marginBottom: 12 }}>
            Перезагрузите панель и проверьте доступность сервера.
          </div>
          <button
            onClick={this.reload}
            style={{
              padding: "8px 14px",
              border: "none",
              borderRadius: 6,
              background: "#2980b9",
              color: "#fff",
              cursor: "pointer",
              fontSize: 14,
            }}
          >
            Перезагрузить
          </button>
        </div>
      );
    }
    return this.props.children as any;
  }
}
