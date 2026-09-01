import { useEffect, useState } from "react";
import type { ToastKind } from "../lib/tg";

interface Item {
  id: number;
  message: string;
  kind: ToastKind;
}

let _id = 1;

/**
 * Разметка тостов. Вынесена из `ToastHost` отдельным компонентом без хуков,
 * чтобы её можно было вызвать обычной функцией и проверить возвращённое
 * VNode-дерево: DOM-харнесса (jsdom/happy-dom) у Mini App нет.
 *
 * Контейнер — live-region, и он рисуется ВСЕГДА, даже пустым. Это не
 * формальность: скринридер объявляет узлы, вставленные в уже существующий
 * live-region, и молчит, если сам регион появился в DOM одновременно с
 * содержимым. Раньше здесь стоял `if (items.length === 0) return null`, то
 * есть контейнер исчезал ровно тогда, когда тостов нет, — а появлялся вместе
 * с первым же тостом. Через `toast()` идут все короткие сообщения Mini App,
 * включая «Только для админа» и «Не удалось: N из M» после одобрения
 * действий, которые публикуются наружу.
 *
 * `polite`, а не `assertive`, и без `role="alert"` на самих тостах: вложенный
 * live-region внутри другого live-region даёт либо двойное объявление, либо
 * ни одного. Отдельный assertive-канал для ошибок означал бы два постоянных
 * региона-соседа, а это меняет порядок, в котором тосты встают на экране.
 */
export function ToastList({ items }: { items: Item[] }) {
  return (
    <div
      className="toast-host"
      role="status"
      aria-live="polite"
      aria-atomic="false"
    >
      {items.map((t) => (
        <div className={`toast ${t.kind}`} key={t.id}>
          {t.kind === "success" ? "✓ " : t.kind === "error" ? "⚠ " : ""}
          {t.message}
        </div>
      ))}
    </div>
  );
}

export default function ToastHost() {
  const [items, setItems] = useState<Item[]>([]);

  useEffect(() => {
    function onToast(e: Event) {
      const det = (e as CustomEvent).detail as {
        message: string;
        kind: ToastKind;
        ttlMs: number;
      };
      const id = _id++;
      setItems((cur) => [...cur, { id, message: det.message, kind: det.kind }]);
      setTimeout(() => {
        setItems((cur) => cur.filter((x) => x.id !== id));
      }, det.ttlMs);
    }
    window.addEventListener("miniapp-toast", onToast);
    return () => window.removeEventListener("miniapp-toast", onToast);
  }, []);

  return <ToastList items={items} />;
}
