/**
 * Всё, что знает о вёрстке Доставки в Яндекс Go, — здесь и только здесь.
 *
 * НЕ сверено: страница доставки видна только после входа, живой осмотр
 * агентом запрещён. Тексты ниже — предположения по аналогии с такси; владелец
 * сверяет их на своём профиле (`bun mac-daemon/delivery.ts probe`) и правит
 * этот файл. Если локатор не нашёл элемент, исполнитель останавливается с
 * отказом и скриншотом — догадок на странице нет.
 */
import type { DeliveryOrderState } from "../lib/delivery.ts";

/** НЕ сверено: доставка — вкладка на той же странице, что и такси. */
export const DELIVERY_START_URL = "https://taxi.yandex.ru/";

export const DELIVERY_ORDER_HOSTS = [/^taxi\.yandex\.ru$/, /^go\.yandex(?:\.ru)?$/, /^dostavka\.yandex\.ru$/];
export const DELIVERY_LOGIN_HOSTS = [/^passport\.yandex\.ru$/, /^sso\.passport\.yandex\.ru$/];

/** НЕ сверено. */
export const DELIVERY_TEXT = {
  tab: /^Доставка$/,
  from: /^(?:Откуда|Адрес отправителя|Забрать)/,
  to: /^(?:Куда|Адрес получателя|Доставить)/,
  login: /^Войти$/,
  order: /^(?:Заказать|Вызвать курьера|Отправить)/,
  comment: /Комментарий(?: курьеру)?/,
  cancel: /^Отменить(?: заказ| доставку)?$/,
  cancelConfirm: /^(?:Да, отменить|Отменить доставку|Отменить заказ)$/,
  addressNotFound: /Адрес не найден|Ничего не нашлось|Не удалось найти/i,
  /** Пустое обязательное поле телефона или имени: такие заказы агент не оформляет. */
  contact: /^(?:Телефон|Номер телефона|Имя)(?: отправителя| получателя)?/,
};

/** Капча и антибот. Страницу с ними не трогаем вовсе — только скриншот. */
export const DELIVERY_CAPTCHA_URL = /showcaptcha|\/captcha|checkcaptcha/i;
export const DELIVERY_CAPTCHA_TEXT = /Я не робот|Подтвердите, что запросы отправляли вы|SmartCaptcha|Вы не робот\?/i;
export const DELIVERY_CAPTCHA_FRAME = /captcha/i;

export const DELIVERY_SUGGESTION_ROLES = ["option", "listitem"] as const;

/** НЕ сверено. Порядок важен: более поздние стадии проверяются раньше. */
export const DELIVERY_STATE_TEXT: ReadonlyArray<[DeliveryOrderState, RegExp]> = [
  ["cancelled", /Заказ отмен[её]н|Доставка отменена/i],
  ["delivered", /Доставлено|Заказ доставлен|Курьер доставил/i],
  ["picked_up", /Курьер забрал|Везёт заказ|В пути к получателю/i],
  ["courier_assigned", /Курьер (?:едет|в пути|назначен)|Приедет через|Подъедет через/i],
  ["searching", /Ищем курьера|Поиск курьера/i],
];

export const DELIVERY_ETA_TEXT = /\d+\s*(?:ч\s*\d+\s*)?мин/;

export const DELIVERY_STATE_POLL = { attempts: 15, intervalMs: 1_000 };
