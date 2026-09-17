/**
 * Всё, что знает о вёрстке Яндекс Go, — здесь и только здесь.
 *
 * Вёрстка меняется без предупреждения, а страница заказа видна только после
 * входа, поэтому локаторы — по ролям и видимому тексту, не по классам, и
 * сверяются на живом профиле владельца: `bun mac-daemon/taxi.ts probe`
 * печатает дерево доступности текущей страницы. Если локатор не нашёл
 * элемент, исполнитель останавливается с отказом и скриншотом — догадок нет.
 *
 * Сверено на живом профиле в сентябре 2026: поля «Откуда» и «Куда?», тарифы —
 * radio внутри radiogroup «Выберите тариф» с текстом «10 мин Эконом Цена 654 ₽».
 */
import type { TaxiOrderState, TaxiTariff } from "../lib/taxi.ts";

export const TAXI_START_URL = "https://taxi.yandex.ru/";

/** Хосты, на которых исполнитель работает. Паспорт — это вход: отказ `login_required`. */
export const TAXI_ORDER_HOSTS = [/^taxi\.yandex\.ru$/, /^go\.yandex(?:\.ru)?$/];
export const TAXI_LOGIN_HOSTS = [/^passport\.yandex\.ru$/, /^sso\.passport\.yandex\.ru$/];

export const TAXI_TEXT = {
  from: /^Откуда/,
  to: /^Куда/,
  login: /^Войти$/,
  order: /^Заказать/,
  cancel: /^Отменить(?: заказ| поездку)?$/,
  cancelConfirm: /^(?:Да, отменить|Отменить поездку|Отменить заказ)$/,
  addressNotFound: /Адрес не найден|Ничего не нашлось|Не удалось найти/i,
  tariffGroup: /^Выберите тариф/,
};

/** Название тарифа на странице; «Бизнес» там латиницей. */
export const TAXI_PAGE_TARIFFS: Record<TaxiTariff, string> = {
  econom: "Эконом",
  comfort: "Комфорт",
  comfortplus: "Комфорт+",
  business: "Business",
  minivan: "Минивэн",
};

/** «Цена от 135 ₽» — минимальная цена, пока не выбрано «Куда»; заказывать по ней нельзя. */
export const TAXI_PRICE_FROM = /от\s*\d/;

/** Капча и антибот. Страницу с ними не трогаем вовсе — только скриншот. */
export const TAXI_CAPTCHA_URL = /showcaptcha|\/captcha|checkcaptcha/i;
export const TAXI_CAPTCHA_TEXT = /Я не робот|Подтвердите, что запросы отправляли вы|SmartCaptcha|Вы не робот\?/i;
export const TAXI_CAPTCHA_FRAME = /captcha/i;

/** Порядок важен: более поздние стадии проверяются раньше. */
export const TAXI_STATE_TEXT: ReadonlyArray<[TaxiOrderState, RegExp]> = [
  ["cancelled", /Заказ отмен[её]н|Поездка отменена/i],
  ["finished", /Поездка завершена|Оцените поездку|Как вам поездка/i],
  ["riding", /Поездка началась|В пути до/i],
  ["driver_arrived", /Водитель (?:на месте|ждёт|ожидает)|Машина на месте/i],
  ["driver_assigned", /Водитель (?:едет|в пути)|Приедет через|Подъедет через|Машина назначена/i],
  ["searching", /Ищем (?:машину|водителя)|Поиск машины/i],
];

/** Российский госномер: буквы, совпадающие по начертанию с латиницей. */
export const TAXI_PLATE = /[АВЕКМНОРСТУХABEKMHOPCTYX]\s?\d{3}\s?[АВЕКМНОРСТУХABEKMHOPCTYX]{2}\s?\d{2,3}/;
export const TAXI_PRICE_TEXT = /(?:от\s*)?\d[\d\s\u00a0\u202f]*(?:\s*[–—-]\s*\d[\d\s\u00a0\u202f]*)?\s*₽/;
export const TAXI_ETA_TEXT = /\d+\s*(?:ч\s*\d+\s*)?мин/;

/** Сколько ждать смены состояния после нажатия «Заказать» и «Отменить». */
export const TAXI_STATE_POLL = { attempts: 15, intervalMs: 1_000 };
/** Сколько ждать точной цены после выбора адресов. */
export const TAXI_PRICE_POLL = { attempts: 30, intervalMs: 500 };
