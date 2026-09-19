/**
 * Опрос Mac для слежения за заказом (lib/order-watch.ts).
 *
 * Отдельный модуль, потому что сам `order-watch.ts` нарочно не знает ни про
 * мост, ни про Яндекс: он про расписание и про то, когда писать владельцу.
 * Здесь — ровно один вопрос странице, `{op:"status"}`, тот же самый, что задают
 * инлайновые TAXI_STATUS / SHOP_STATUS / DELIVERY_STATUS. Ничего не заказывает,
 * не отменяет и не жмёт; страницу не читает дальше состояния.
 *
 * Сбой моста — не промах заказа: Mac спит, занят другим прогоном или ответил
 * позже таймаута. Такие ответы уходят с `retry: true`, и слежение пробует ещё
 * раз, не тратя счётчик промахов и не закрываясь раньше времени.
 */
import { sendDeliveryToMac, sendShopToMac, sendTaxiToMac } from "./mac-bridge.ts";
import { parseDeliveryOutcome } from "./delivery.ts";
import { parseShopOutcome } from "./shop.ts";
import { parseTaxiOutcome } from "./taxi.ts";
import type { OrderWatchProbe, OrderWatchRow } from "./order-watch.ts";
import { shopServiceOfKind } from "./order-watch.ts";

/** Ошибки моста, после которых имеет смысл просто спросить позже. */
const RETRYABLE = /^(mac_offline|mac_busy|mac_timeout|mac_disconnected)/;

const failed = (error: string): OrderWatchProbe => ({
  ok: false,
  error,
  retry: RETRYABLE.test(error),
});

/**
 * Спросить у Mac состояние заказа этого слежения.
 *
 * Пользователь берётся из строки слежения, а не из аргумента: мост проверяет,
 * что это владелец и что чат — его личный, и подменить это через полёт данных
 * из payload'а нельзя.
 */
export async function probeOrderOnMac(r: OrderWatchRow): Promise<OrderWatchProbe> {
  try {
    const service = shopServiceOfKind(r.kind);
    if (service) {
      const res = await sendShopToMac({ op: "status", service }, r.user_id, r.chat_id);
      if (!res.ok) return failed(res.error ?? "shop_failed");
      const out = parseShopOutcome(res.stdout, "status");
      if (!out.ok) return { ok: false, error: out.code };
      if (out.op !== "status") return { ok: false, error: "invalid_shop_result" };
      return { ok: true, state: out.state, eta_min: out.eta_min, driver: null };
    }
    if (r.kind === "taxi") {
      const res = await sendTaxiToMac({ op: "status" }, r.user_id, r.chat_id);
      if (!res.ok) return failed(res.error ?? "taxi_failed");
      const out = parseTaxiOutcome(res.stdout, "status");
      if (!out.ok) return { ok: false, error: out.code };
      if (out.op !== "status") return { ok: false, error: "invalid_taxi_result" };
      // У такси время подачи живёт в карточке водителя, отдельного поля нет.
      return { ok: true, state: out.state, eta_min: out.driver?.eta_min ?? null, driver: out.driver };
    }
    const res = await sendDeliveryToMac({ op: "status" }, r.user_id, r.chat_id);
    if (!res.ok) return failed(res.error ?? "delivery_failed");
    const out = parseDeliveryOutcome(res.stdout, "status");
    if (!out.ok) return { ok: false, error: out.code };
    if (out.op !== "status") return { ok: false, error: "invalid_delivery_result" };
    return { ok: true, state: out.state, eta_min: out.eta_min, driver: null };
  } catch (e) {
    return failed(e instanceof Error ? e.message : String(e));
  }
}
