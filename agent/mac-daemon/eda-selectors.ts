/**
 * Всё, что знает о вёрстке Яндекс Еды, — здесь и только здесь.
 *
 * Сверено на публичных страницах без входа (сентябрь 2026): ссылки ресторанов
 * `/r/<бренд>?placeSlug=<slug>`, заголовок сниппета ресторана и карточки меню
 * `product-card-v2-*` (название, цена, вес, кнопка «В корзину»).
 *
 * НЕ сверено — видно только после входа и выбора адреса, а живой осмотр сайта
 * агентом не разрешён: страница поиска ресторанов, адрес в шапке, счётчик и
 * «минус» на карточке, корзина, оформление, оплата и статус заказа. Их сверяет
 * владелец: `bun mac-daemon/shop.ts probe eda`, правится только этот файл. Не
 * нашёл элемент — отказ до оплаты со скриншотом, догадок нет.
 */
import type { ShopOrderState } from "../lib/shop.ts";

export const EDA_ORIGIN = "https://eda.yandex.ru";
/** НЕ сверено: маршрут поиска. Если пусто — адаптер берёт рестораны с главной. */
export const edaSearchUrl = (query: string) => `${EDA_ORIGIN}/search?query=${encodeURIComponent(query)}`;
/** НЕ сверено. */
export const EDA_ORDERS_URL = `${EDA_ORIGIN}/orders`;

export const EDA_HOSTS = [/^eda\.yandex\.ru$/];
export const EDA_LOGIN_HOSTS = [/^passport\.yandex\.ru$/, /^sso\.passport\.yandex\.ru$/];

export const EDA_TESTID = {
  // сверено
  placeLink: 'a[href^="/r/"]',
  placeTitle: '[data-testid="place-snippet-title"]',
  dishCard: '[data-testid="product-card-v2-root"]',
  dishTitle: '[data-testid="product-card-v2-title"]',
  dishPrice: '[data-testid="product-card-v2-price"]',
  dishMeta: '[data-testid="product-card-v2-hard-meta"]',
  dishPlus: '[data-testid="product-card-v2-counter-increase-btn"]',
  // НЕ сверено
  dishMinus: '[data-testid="product-card-v2-counter-decrease-btn"]',
  dishCounter: '[data-testid="product-card-v2-counter-value"]',
  addressButton: '[data-testid="header-address-button"]',
  cart: '[data-testid="cart"]',
  cartItem: '[data-testid="cart-item"]',
  cartItemTitle: '[data-testid="cart-item-title"]',
  cartItemCounter: '[data-testid="cart-item-counter-value"]',
  cartItemPrice: '[data-testid="cart-item-price"]',
};

export const EDA_TEXT = {
  // сверено: шапка без адреса и без входа
  addressUnset: /Укажите адрес/i,
  signIn: /^Войти$/,
  addressModal: /Куда доставить заказ\?/i,
  // НЕ сверено
  outOfStock: /Нет в наличии|Закончил(?:ся|ась|ось|ись)|Недоступно|Стоп-лист/i,
  placeClosed: /Ресторан закрыт|Сейчас закрыт|Не принимает заказы|Откроется в/i,
  freeDelivery: /Бесплатная доставка|Доставка 0 ₽/i,
  deliveryFee: /Доставка\s+(\d{1,5})\s?₽/i,
  cartEmpty: /В корзине пока пусто|Корзина пуста|В корзине пока ничего нет/i,
  checkout: /^(?:Оформить(?: заказ)?|К оформлению|Перейти к оформлению|Далее)/,
  pay: /^(?:Оплатить|Заказать и оплатить|Оформить и оплатить)/,
  savedCard: /(?:•{2,}|\*{2,}|··)\s?\d{4}|Сбер ?Пэй|SberPay|Яндекс Пэй|Yandex Pay/i,
  total: /^Итого/i,
  checkoutBlocked: /Минимальная сумма заказа|Ресторан закрыт|Не доставляем|Не доставляет по этому адресу|Сейчас не принимает заказы/i,
};

/** Капча и антибот: страницу не трогаем, только скриншот. */
export const EDA_CAPTCHA_URL = /showcaptcha|\/captcha|checkcaptcha/i;
export const EDA_CAPTCHA_TEXT = /Я не робот|Подтвердите, что запросы отправляли вы|SmartCaptcha|Вы не робот\?/i;
export const EDA_CAPTCHA_FRAME = /captcha/i;

/** НЕ сверено. Порядок важен: более поздние стадии проверяются раньше. */
export const EDA_STATE_TEXT: ReadonlyArray<[ShopOrderState, RegExp]> = [
  ["cancelled", /Заказ отмен[её]н/i],
  ["delivered", /Заказ доставлен|Доставили|Приятного аппетита/i],
  ["delivering", /Курьер (?:в пути|едет|уже едет|забрал заказ)|Везём заказ|Передали курьеру/i],
  ["assembling", /Готовим|Ресторан готовит|Заказ готовится|Собираем заказ/i],
  ["accepted", /Заказ (?:принят|оформлен|оплачен)|Ресторан принял заказ|Спасибо за заказ/i],
  ["payment_pending", /Ожидает оплаты|Подтвердите оплату|Не удалось оплатить|3-D ?Secure/i],
];

/** Сколько раз прокручивать меню, чтобы догрузились все карточки. */
export const EDA_MENU_SCROLLS = 12;
