/**
 * Всё, что знает о вёрстке Яндекс Еды, — здесь и только здесь.
 *
 * Сверено (сентябрь 2026, публичные страницы и живой профиль с адресом): ссылки
 * ресторанов `/r/<бренд>?placeSlug=<slug>`, заголовки ресторанов на главной и в
 * поиске, поиск `/search?query=`, адрес в шапке, «Доставка N ₽» на странице
 * ресторана и карточки меню `product-card-v2-*` (название, цена, вес, «В корзину»).
 *
 * Сверено на живой корзине (положили и убрали): счётчик и «минус» на карточке,
 * окно блюда с опциями (`product-full-card-*`, группы `h4` + `label` с
 * radio/checkbox и доплатой «+ N ₽»), строки корзины `product-card-row-root`
 * (название, отмеченные опции, сумма строки, вес, количество) и пустая корзина.
 *
 * НЕ сверено: оформление, оплата и статус заказа. Их сверяет
 * владелец: `bun mac-daemon/shop.ts probe eda`, правится только этот файл. Не
 * нашёл элемент — отказ до оплаты со скриншотом, догадок нет.
 */
import type { ShopOrderState } from "../lib/shop.ts";

export const EDA_ORIGIN = "https://eda.yandex.ru";
/** Поиск ресторанов; ничего не нашлось — адаптер берёт рестораны с главной. */
export const edaSearchUrl = (query: string) => `${EDA_ORIGIN}/search?query=${encodeURIComponent(query)}`;
/** НЕ сверено. */
export const EDA_ORDERS_URL = `${EDA_ORIGIN}/orders`;

export const EDA_HOSTS = [/^eda\.yandex\.ru$/];
export const EDA_LOGIN_HOSTS = [/^passport\.yandex\.ru$/, /^sso\.passport\.yandex\.ru$/];

export const EDA_TESTID = {
  // сверено
  placeLink: 'a[href^="/r/"]',
  // сниппет на главной и заголовок карточки в поиске
  placeTitle: '[data-testid="place-snippet-title"], [data-testid="place-header-title"]',
  dishCard: '[data-testid="product-card-v2-root"]',
  dishTitle: '[data-testid="product-card-v2-title"]',
  dishPrice: '[data-testid="product-card-v2-price"]',
  dishMeta: '[data-testid="product-card-v2-hard-meta"]',
  dishPlus: '[data-testid="product-card-v2-counter-increase-btn"]',
  dishMinus: '[data-testid="product-card-v2-counter-decrease-btn"]',
  /** Сколько этого блюда в корзине — сумма по всем вариантам опций. */
  dishCounter: '[data-testid="product-card-v2-counter-count"]',
  // окно блюда: открывается кликом по карточке
  fullName: '[data-testid="product-full-card-name"]',
  fullWeight: '[data-testid="product-full-card-weight"]',
  fullPrice: '[data-testid="product-full-card-current-price"]',
  fullAdd: '[data-testid="product-full-card-add-to-cart"]',
  fullAddDisabled: '[data-testid="product-full-card-add-to-cart-disabled"]',
  optionInput: 'input[data-testid="checkbox-control"]',
  amountDec: '[data-testid="amount-select-decrement"]',
  amountInc: '[data-testid="amount-select-increment"]',
  amountValue: '[data-testid="item-quantity"]',
  // окно адреса: открывается кликом по адресу в шапке
  // «Заказ на этот адрес?» — тоже role=dialog, поэтому окно адресов узнаём по списку внутри
  addressDialog: '[role="dialog"]:has([role="radiogroup"])',
  addressRadio: 'button[role="radio"]',
  // корзина — боковая панель на странице ресторана
  cartRow: '[data-testid="product-card-row-root"]',
  cartRowName: '[data-testid="cart-item-name"]',
};

export const EDA_TEXT = {
  // сверено: шапка без адреса и без входа
  addressUnset: /Укажите адрес/i,
  signIn: /^Войти$/,
  addressModal: /Куда доставить заказ\?/i,
  /** Адрес в шапке — кнопка без testid; остальные кнопки шапки узнаём по названию. */
  headerNotAddress: /^(?:Уведомления|Корзина|Профиль|Войти|Укажите адрес)?$/i,
  /** Прочие кнопки шапки: всё остальное — адрес, даже «Укажите адрес». */
  headerOther: /^(?:Уведомления|Корзина|Профиль|Войти)$/i,
  // НЕ сверено
  deliveryFee: /Доставка\s+(\d{1,5})\s?₽/i,
  // НЕ сверено
  outOfStock: /Нет в наличии|Закончил(?:ся|ась|ось|ись)|Недоступно|Стоп-лист/i,
  placeClosed: /Ресторан закрыт|Сейчас закрыт|Не принимает заказы|Откроется в/i,
  freeDelivery: /Бесплатная доставка|Доставка 0 ₽/i,
  // сверено
  cartEmpty: /Пусто,\s+как\s+ночью\s+в\s+холодильнике/i,
  cartHeading: /^Корзина$/,
  closeDialog: /^Закрыть модальное окно$/,
  // НЕ сверено
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
