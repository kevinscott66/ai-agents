/**
 * Всё, что знает о вёрстке Яндекс Маркета, — здесь и только здесь.
 *
 * Сверено на живом профиле (сентябрь 2026): поиск, сниппеты, ссылки
 * `/card/<slug>/<номер>`, пункт доставки в шапке, заголовок, цена и «В корзину»
 * на карточке. Маршрут `/product/<номер>` уводит на капчу — не использовать.
 *
 * Счётчик на карточке и строки корзины сверены живьём (сентябрь 2026) — товар
 * клали в корзину и убирали обратно.
 *
 * НЕ сверено (видно только на оформлении, а туда агент не ходит): оформление,
 * оплата и статусы заказа. Сверяет владелец (`bun mac-daemon/shop.ts probe market`),
 * правится только этот файл. Не нашёл элемент — отказ до оплаты со скриншотом.
 */
import type { ShopOrderState } from "../lib/shop.ts";

export const MARKET_ORIGIN = "https://market.yandex.ru";
export const marketSearchUrl = (query: string) => `${MARKET_ORIGIN}/search?text=${encodeURIComponent(query)}`;
/** Карточка по номеру; настоящий slug Маркет подставляет сам редиректом. */
export const marketProductUrl = (id: string) => `${MARKET_ORIGIN}/card/x/${encodeURIComponent(id)}`;
export const MARKET_CART_URL = `${MARKET_ORIGIN}/my/cart`;
export const MARKET_ORDERS_URL = `${MARKET_ORIGIN}/my/orders`;

export const MARKET_HOSTS = [/^market\.yandex\.ru$/];
export const MARKET_LOGIN_HOSTS = [/^passport\.yandex\.ru$/, /^sso\.passport\.yandex\.ru$/];

export const MARKET_TESTID = {
  // сверено
  snippet: '[data-zone-name="productSnippet"]',
  snippetLink: 'a[href^="/card/"]',
  snippetTitle: '[data-auto="snippet-title"]',
  snippetPrice: '[data-auto="snippet-price-current"]',
  productTitle: 'h1[data-auto="productCardTitle"]',
  productOffer: '[data-auto="default-offer-actions"]',
  productPrice: '[data-auto="snippet-price-current"]',
  cartButton: '[data-auto="cartButton"]',
  addressButton: '[data-zone-name="deliveryPoint"]',
  // Счётчик на карточке: «−  1  +» внутри блока предложения. Число — это input,
  // читать надо value, а не текст.
  qtyCounter: '[data-auto="default-offer-actions"] [data-auto="counter-cart-button"]',
  qtyValue: '[data-auto="default-offer-actions"] [data-auto="counter-cart-button"] input[data-auto="amount"]',
  // Строка корзины: у каждой свой номер в data-auto — `cartItem-1789672288320`.
  cartItem: '[data-auto^="cartItem-"]',
  cartItemLink: 'a[data-auto="snippet-link"]',
  cartItemQty: '[data-zone-name="amountSelect"] input',
  cartItemPrice: '[data-auto="snippet-price-current"]',
};

export const MARKET_TEXT = {
  addressUnset: /Укажите адрес|Выберите адрес|Куда доставить/i,
  /** Сверено: «Пункт выдачи · улица …» — тип точки перед адресом. */
  addressPrefix: /^(?:Пункт выдачи|Курьером|Доставка)\s*·\s*/i,
  signIn: /^Войти$/,
  addToCart: /^(?:В корзину|Добавить в корзину)$/,
  /** Кнопки счётчика подписаны для читалки экрана, текст на них — «−» и «+». */
  qtyPlus: /^Увеличить/,
  qtyMinus: /^Уменьшить/,
  /** Корзина спрашивает подтверждение: «Удалить выбранные товары?». */
  removeConfirm: /^Удалить$/,
  outOfStock: /Нет в продаже|Нет в наличии|Раскупили|Товар закончился/i,
  optionsRequired: /Выберите (?:размер|цвет|вариант)/i,
  cartEmpty: /В корзине (?:пока )?(?:пусто|ничего нет)|Корзина пуст(?:а|ая)/i,
  checkout: /^(?:Перейти к оформлению|Оформить(?: заказ)?|К оформлению)/,
  pay: /^(?:Подтвердить заказ|Оплатить|Оформить и оплатить)/,
  savedCard: /(?:•{2,}|\*{2,}|··)\s?\d{4}|Сбер ?Пэй|SberPay|Яндекс Пэй|Yandex Pay/i,
  payOnDelivery: /При получении/i,
  total: /^Итого/i,
  checkoutBlocked: /Недоступно для доставки|Не доставляем|Нет в наличии|Товар закончился|Минимальная сумма заказа/i,
};

export const MARKET_CAPTCHA_URL = /showcaptcha|\/captcha|checkcaptcha/i;
export const MARKET_CAPTCHA_TEXT = /Я не робот|Подтвердите, что запросы отправляли вы|SmartCaptcha|Вы не робот\?/i;
export const MARKET_CAPTCHA_FRAME = /captcha/i;

/** Порядок важен: более поздние стадии проверяются раньше. */
export const MARKET_STATE_TEXT: ReadonlyArray<[ShopOrderState, RegExp]> = [
  ["cancelled", /Заказ отмен[её]н|Отмен[её]н/i],
  ["delivered", /Заказ (?:доставлен|получен)|Получен|Вручён/i],
  ["delivering", /Передан в доставку|В пути|Курьер (?:в пути|едет)|Ждёт в пункте выдачи|Можно забирать/i],
  ["assembling", /Собираем заказ|В сборке|Готовим к отправке|Продавец собирает/i],
  ["accepted", /Заказ (?:принят|оформлен|оплачен)|Спасибо за заказ/i],
  ["payment_pending", /Ожидает оплаты|Подтвердите оплату|Не удалось оплатить|3-D ?Secure/i],
];
