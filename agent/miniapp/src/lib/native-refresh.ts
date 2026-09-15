import { useEffect, useRef } from "react";
import { nativePanel } from "./native";
/** Refresh visible native data views without impersonating SSE event payloads. */
export function useNativeRefresh(refresh: () => Promise<unknown>) {
  const current = useRef(refresh); current.current = refresh;
  useEffect(() => {
    if (!nativePanel) return;
    let busy = false;
    const timer = setInterval(async () => {
      if (busy || document.hidden || /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || "")) return;
      busy = true;
      try { await current.current(); } finally { busy = false; }
    }, 15000);
    return () => clearInterval(timer);
  }, []);
}
