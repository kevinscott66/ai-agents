import { useEffect, useRef, useState, useCallback } from "preact/hooks";

export type AsyncStatus = "loading" | "success" | "error";

export interface AsyncState<T> {
  status: AsyncStatus;
  data: T | null;
  error: Error | null;
  reload: () => void;
}

/**
 * Запускает async-функцию (получающую AbortSignal) при монтировании и при
 * смене `deps`. Отменяет предыдущий запрос. `reload` принудительно повторяет.
 */
export function useAsync<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  deps: unknown[] = [],
): AsyncState<T> {
  const [status, setStatus] = useState<AsyncStatus>("loading");
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [nonce, setNonce] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    const ctrl = new AbortController();
    let active = true;
    setStatus("loading");
    setError(null);
    fnRef
      .current(ctrl.signal)
      .then((res) => {
        if (!active) return;
        setData(res);
        setStatus("success");
      })
      .catch((e: Error) => {
        if (!active || e.name === "AbortError") return;
        setError(e);
        setStatus("error");
      });
    return () => {
      active = false;
      ctrl.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  return { status, data, error, reload };
}
