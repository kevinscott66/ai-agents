import { nativePanel } from "../lib/native";
interface Props {
  message?: string | null;
  onRetry?: () => void;
  hint?: string;
}

/**
 * Friendly error block with a retry button. Used by pages on fetch failure
 * (network error, 5xx) so the user isn't left staring at an empty list.
 */
export function ErrorBox({ message, onRetry, hint }: Props) {
  if (!message) return null;
  if (nativePanel) return <div className="native-error" role="alert">
    <strong>Панель недоступна</strong><p>{message}</p>
    {onRetry && <button className="btn secondary" onClick={onRetry}>Обновить</button>}
  </div>;
  return (
    <div className="error-box" role="alert">
      <div style={{ fontWeight: 600, marginBottom: 4 }}>
        Не удалось загрузить
      </div>
      <div style={{ fontSize: 12, opacity: 0.85, marginBottom: 6 }}>
        {hint ?? "Проверь интернет и попробуй ещё раз."}
      </div>
      <div style={{ fontSize: 11, opacity: 0.65, marginBottom: 8, fontFamily: "ui-monospace, Menlo, monospace", wordBreak: "break-word" }}>
        {message}
      </div>
      {onRetry ? (
        <button
          type="button"
          className="btn"
          onClick={onRetry}
          aria-label="Повторить загрузку"
        >
          Повторить
        </button>
      ) : null}
    </div>
  );
}
