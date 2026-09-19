/**
 * Всё, что знает о вёрстке Доставки в Яндекс Go, — здесь и только здесь.
 *
 * Сверено на живом профиле в сентябре 2026 (расчёт, без заказа): у taxi.yandex.ru
 * вкладки доставки нет, курьер заказывается на dostavka.yandex.ru/order/express.
 * Там два поля «Улица, дом» (откуда, куда), телефоны отправителя и получателя
 * и варианты — radio `offer_name` с текстом «Экспресс за 45 минут … 535 ₽».
 * Не сверены: комментарий, отмена и стадии заказа — заказ не оформлялся.
 * Если локатор не нашёл элемент, исполнитель останавливается с отказом и
 * скриншотом — догадок на странице нет.
 */
import type { DeliveryOrderState, DeliveryTariff } from "../lib/delivery.ts";

export const DELIVERY_START_URL = "https://dostavka.yandex.ru/order/express/";

export const DELIVERY_ORDER_HOSTS = [/^dostavka\.yandex\.ru$/];
export const DELIVERY_LOGIN_HOSTS = [/^passport\.yandex\.ru$/, /^sso\.passport\.yandex\.ru$/];

export const DELIVERY_TEXT = {
  /** Первое поле — откуда, второе — куда. */
  address: /^Улица, дом$/,
  login: /^Войти$/,
  order: /^Заказать/,
  /** Хвост подписи неактивной кнопки, когда в аккаунте нет способа оплаты. */
  addPayment: /Добавьте способ оплаты/i,
  /** Кнопка на месте «Заказать», пока аккаунт не подтвердил имя и телефон. */
  confirmData: /^Подтвердите данные/i,
  /** НЕ сверено. */
  comment: /Комментарий(?: курьеру)?/,
  cancel: /^Отменить(?: заказ| доставку)?$/,
  cancelConfirm: /^(?:Да, отменить|Отменить доставку|Отменить заказ)$/,
  addressNotFound: /Адрес не найден|Ничего не нашлось|Не удалось найти/i,
  /** Пустое обязательное поле телефона или имени: такие заказы агент не оформляет. */
  contact: /^(?:Телефон|Номер телефона|Имя)(?: отправителя| получателя)?/,
  senderPhone: /^Телефон отправителя/,
  recipientPhone: /^Телефон получателя/,
};

/**
 * Вариант на странице — значение radio `offer_name`. «Курьер» и «Грузовой»
 * на этой странице — не варианты срока, а другие услуги; их нет в расчёте.
 */
export const DELIVERY_OFFERS: Partial<Record<DeliveryTariff, string>> = {
  express: "express_d2d",
};
export const DELIVERY_OFFER_INPUT = "input[type=radio][name=offer_name]";

/** Капча и антибот. Страницу с ними не трогаем вовсе — только скриншот. */
export const DELIVERY_CAPTCHA_URL = /showcaptcha|\/captcha|checkcaptcha/i;
export const DELIVERY_CAPTCHA_TEXT = /Я не робот|Подтвердите, что запросы отправляли вы|SmartCaptcha|Вы не робот\?/i;
export const DELIVERY_CAPTCHA_FRAME = /captcha/i;

/** НЕ сверено. Порядок важен: более поздние стадии проверяются раньше. */
export const DELIVERY_STATE_TEXT: ReadonlyArray<[DeliveryOrderState, RegExp]> = [
  ["cancelled", /Заказ отмен[её]н|Доставка отменена/i],
  ["delivered", /Доставлено|Заказ доставлен|Курьер доставил/i],
  ["picked_up", /Курьер забрал|Везёт заказ|В пути к получателю/i],
  ["courier_assigned", /Курьер (?:едет|в пути|назначен)|Приедет через|Подъедет через/i],
  ["searching", /Ищем курьера|Поиск курьера/i],
];

export const DELIVERY_ETA_TEXT = /\d+\s*(?:ч\s*\d+\s*)?мин/;
/** «за 1 час 15 минут заберут и доставят». */
export const DELIVERY_OFFER_ETA = /за\s+(?:(\d+)\s*час\S*\s*)?(?:(\d+)\s*мин)?/;

export const DELIVERY_STATE_POLL = { attempts: 15, intervalMs: 1_000 };
/**
 * Сколько перечитывать кнопку «Заказать», пока она не устоялась: сразу после
 * выбора тарифа её ещё нет или она неактивна без причины в подписи, а через
 * секунду появляется «Добавьте способ оплаты» или цена.
 */
export const DELIVERY_BUTTON_POLL = { attempts: 4, intervalMs: 1_000 };
/** Сколько ждать цен после выбора адресов. */
export const DELIVERY_PRICE_POLL = { attempts: 30, intervalMs: 500 };
