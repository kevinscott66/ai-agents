/**
 * Всё, что знает о вёрстке Яндекс Маркета, — здесь и только здесь.
 *
 * НИЧЕГО не сверено на живом сайте: агент Маркет не осматривал. Маршруты,
 * data-auto и подписи ниже — отправная точка; сверяет владелец на своём
 * профиле (`bun mac-daemon/shop.ts probe market`), правится только этот файл.
 * Не нашёл элемент — отказ до оплаты со скриншотом, догадок нет.
 */
import type { ShopOrderState } from "../lib/shop.ts";

export const MARKET_ORIGIN = "https://market.yandex.ru";
export const marketSearchUrl = (query: string) => `${MARKET_ORIGIN}/search?text=${encodeURIComponent(query)}`;
/** Товар по modelId и sku; slug в пути Маркет подставляет сам. */
export const marketProductUrl = (model: string, sku: string) =>
  `${MARKET_ORIGIN}/product/${encodeURIComponent(model)}?sku=${encodeURIComponent(sku)}`;
export const MARKET_CART_URL = `${MARKET_ORIGIN}/my/cart`;
export const MARKET_ORDERS_URL = `${MARKET_ORIGIN}/my/orders`;

export const MARKET_HOSTS = [/^market\.yandex\.ru$/];
export const MARKET_LOGIN_HOSTS = [/^passport\.yandex\.ru$/, /^sso\.passport\.yandex\.ru$/];

export const MARKET_TESTID = {
  snippet: '[data-zone-name="productSnippet"]',
  snippetLink: 'a[href*="sku="]',
  snippetTitle: '[data-auto="snippet-title"]',
  snippetPrice: '[data-auto="snippet-price-current"]',
  productTitle: 'h1[data-auto="productCardTitle"]',
  productOffer: '[data-auto="default-offer"]',
  productPrice: '[data-auto="snippet-price-current"]',
  cartButton: '[data-auto="cartButton"]',
  qtyValue: '[data-auto="cartButton"] [data-auto="amount"]',
  qtyPlus: '[data-auto="cartButton"] [data-auto="increase"]',
  qtyMinus: '[data-auto="cartButton"] [data-auto="decrease"]',
  addressButton: '[data-auto="deliveryAddressButton"]',
  cartItem: '[data-auto="cartItem"]',
  cartItemLink: 'a[href*="sku="]',
  cartItemQty: '[data-auto="amount"]',
  cartItemPrice: '[data-auto="price-value"]',
};

export const MARKET_TEXT = {
  addressUnset: /Укажите адрес|Выберите адрес|Куда доставить/i,
  signIn: /^Войти$/,
  addToCart: /^(?:В корзину|Добавить в корзину)$/,
  outOfStock: /Нет в продаже|Нет в наличии|Раскупили|Товар закончился/i,
  optionsRequired: /Выберите (?:размер|цвет|вариант)/i,
  cartEmpty: /В корзине (?:пока )?(?:пусто|ничего нет)|Корзина пуста/i,
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
