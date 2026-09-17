/**
 * Всё, что знает о вёрстке Яндекс Лавки, — здесь и только здесь.
 *
 * Поиск, карточки товаров, шапка и мини-корзина видны без входа — их
 * data-testid сверены на публичных страницах (сентябрь 2026). Корзина с
 * товарами, оформление, оплата и статус заказа видны только после входа и
 * выбора адреса, поэтому там локаторы — по ролям и видимому тексту, и их
 * сверяет владелец на живом профиле: `bun mac-daemon/shop.ts probe`. Не нашёл
 * элемент — отказ со скриншотом, догадок нет.
 */
import type { ShopOrderState } from "../lib/shop.ts";

export const LAVKA_ORIGIN = "https://lavka.yandex.ru";
export const lavkaSearchUrl = (query: string) => `${LAVKA_ORIGIN}/search?text=${encodeURIComponent(query)}`;
export const lavkaProductUrl = (id: string) => `${LAVKA_ORIGIN}/good/${encodeURIComponent(id)}`;
export const LAVKA_ORDERS_URL = `${LAVKA_ORIGIN}/orders`;

/** Хосты, на которых исполнитель работает. Паспорт — это вход: отказ `login_required`. */
export const LAVKA_HOSTS = [/^lavka\.yandex\.ru$/];
export const LAVKA_LOGIN_HOSTS = [/^passport\.yandex\.ru$/, /^sso\.passport\.yandex\.ru$/];

export const LAVKA_TESTID = {
  productCard: '[data-testid^="product-id-"]',
  productLink: 'a[href^="/good/"]',
  price: '[data-testid="price-text"]',
  priceOld: '[data-testid="price-old-text"]',
  productTitle: '[data-testid="product-title"]',
  productAmount: '[data-testid="product-amount"]',
  addToCartBar: '[data-testid="add-to-cart-bar"]',
  addToCartButton: '[data-testid="snippet-control"]',
  qtyInput: '[data-testid="keyboard-input"]',
  qtyPlus: '[data-testid="add-spin-button"]',
  qtyMinus: '[data-testid="remove-spin-button"]',
  addressButton: '[data-testid="header-address-selection-button"]',
  // окно «Мои адреса»: открывается кликом по адресу в шапке
  addressModal: '[data-testid="my-addresses-modal"]',
  addressItem: '[data-testid="address-item"]',
  // в строке адреса есть ещё карандаш «изменить» — кликаем строго по подписи
  addressItemTitle: '[data-testid="item-title"]',
  addressModalClose: '[data-testid="modal-close-button"]',
  signIn: '[data-testid="sign-in"]',
  miniCart: '[data-testid="mini-cart"]',
  miniCartDelivery: '[data-testid="min-cart-delivery-conditions-title"]',
  miniCartButton: '[data-testid="mini-cart-button"]',
};

export const LAVKA_TEXT = {
  addressUnset: /Укажите адрес/i,
  demoCatalog: /Это демо-каталог/i,
  cartEmpty: /В корзине пока ничего нет/i,
  outOfStock: /Нет в наличии|Закончил(?:ся|ась|ось|ись)|Раскупили/i,
  checkout: /^(?:Оформить(?: заказ)?|К оформлению|Перейти к оформлению)/,
  pay: /^(?:Оплатить|Заказать и оплатить|Оформить и оплатить)/,
  savedCard: /(?:•{2,}|\*{2,}|··)\s?\d{4}|Сбер ?Пэй|SberPay|Яндекс Пэй|Yandex Pay/i,
  total: /^Итого/i,
  checkoutBlocked: /Минимальная сумма заказа|Сейчас не доставляем|Лавка закрыта|Не доставляем по этому адресу/i,
};

/** Капча и антибот. Страницу с ними не трогаем вовсе — только скриншот. */
export const LAVKA_CAPTCHA_URL = /showcaptcha|\/captcha|checkcaptcha/i;
export const LAVKA_CAPTCHA_TEXT = /Я не робот|Подтвердите, что запросы отправляли вы|SmartCaptcha|Вы не робот\?/i;
export const LAVKA_CAPTCHA_FRAME = /captcha/i;

/** Порядок важен: более поздние стадии проверяются раньше. */
export const LAVKA_STATE_TEXT: ReadonlyArray<[ShopOrderState, RegExp]> = [
  ["cancelled", /Заказ отмен[её]н/i],
  ["delivered", /Заказ доставлен|Доставили|Приятного аппетита/i],
  ["delivering", /Курьер (?:в пути|едет|уже едет)|Везём заказ|Передали курьеру/i],
  ["assembling", /Собираем заказ|Заказ собирается/i],
  ["accepted", /Заказ (?:принят|оформлен|оплачен)|Спасибо за заказ/i],
  ["payment_pending", /Ожидает оплаты|Подтвердите оплату|Не удалось оплатить|3-D ?Secure/i],
];

/** Сколько ждать смены состояния после нажатия «Оплатить». */
export const SHOP_STATE_POLL = { attempts: 20, intervalMs: 1_500 };
