/**
 * Общие приёмы Playwright для страниц Яндекса (такси, доставка, Лавка, Еда, Маркет).
 *
 * playwright-core лежит только в mac-daemon/node_modules — на сервере его нет,
 * поэтому модуль грузится динамически по имени из переменной и без импорта
 * типов. Никаких «стелс»-приёмов: обычный Chrome, обычный профиль; капча — это
 * остановка и скриншот, а не повод прятаться.
 */
const PLAYWRIGHT = "playwright-core";
export const NAV_TIMEOUT_MS = 30_000;
export const UI_TIMEOUT_MS = 8_000;
const BODY_TEXT_MAX = 20_000;

export const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Chrome с постоянным профилем владельца и первой вкладкой с таймаутами.
 * Не загрузился playwright-core или не запустился браузер — `browser_unavailable`.
 */
export async function launchProfileChrome(
  profileDir: string,
  opts: { channel: string; headless: boolean; viewport: { width: number; height: number } },
): Promise<{ context: any; page: any }> {
  let pw: any;
  try {
    pw = await import(PLAYWRIGHT);
  } catch {
    throw new Error("browser_unavailable");
  }
  let context: any;
  try {
    context = await pw.chromium.launchPersistentContext(profileDir, {
      channel: opts.channel,
      headless: opts.headless,
      viewport: opts.viewport,
      locale: "ru-RU",
      timezoneId: "Europe/Moscow",
      acceptDownloads: false,
    });
  } catch {
    throw new Error("browser_unavailable");
  }
  const page = context.pages()[0] ?? (await context.newPage());
  page.setDefaultTimeout(UI_TIMEOUT_MS);
  page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
  return { context, page };
}

export function hostMatches(url: string, hosts: RegExp[]): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && hosts.some((h) => h.test(u.hostname));
  } catch {
    return false;
  }
}

export async function visible(locator: any, timeout = 0): Promise<boolean> {
  try {
    if (timeout) await locator.waitFor({ state: "visible", timeout });
    return await locator.isVisible();
  } catch {
    return false;
  }
}

/** Видимый текст страницы, обрезанный; не прочитался — пустая строка. */
export async function bodyText(page: any): Promise<string> {
  try {
    return String(await page.locator("body").innerText({ timeout: UI_TIMEOUT_MS })).slice(0, BODY_TEXT_MAX);
  } catch {
    return "";
  }
}

/** JPEG в base64 не длиннее `maxB64`: качество снижается, пока не влезет. */
export async function jpegScreenshot(page: any, maxB64: number): Promise<string | null> {
  for (const quality of [45, 30, 18]) {
    try {
      const buf: Uint8Array = await page.screenshot({ type: "jpeg", quality, scale: "css", timeout: UI_TIMEOUT_MS });
      const b64 = Buffer.from(buf).toString("base64");
      if (b64.length <= maxB64) return b64;
    } catch {
      return null;
    }
  }
  return null;
}

/** Дерево доступности страницы для `probe` в CLI владельца. */
export async function ariaProbe(page: any): Promise<string> {
  try {
    return String(await page.locator("body").ariaSnapshot({ timeout: UI_TIMEOUT_MS }));
  } catch (e) {
    return `probe failed: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/**
 * Вписать адрес и выбрать первую подсказку. Список подсказок у Яндекса есть
 * ещё до ввода (история поездок), и он сменяется не сразу, поэтому ждём, пока
 * список станет другим и перестанет меняться; кликнуть по старому списку —
 * значит поехать по чужому адресу. Подсказок нет — false.
 */
export async function fillAddress(page: any, input: any, address: string): Promise<boolean> {
  const options = page.getByRole("option");
  const listText = async () => {
    try {
      return (await options.allInnerTexts()).join("\n");
    } catch {
      return "";
    }
  };
  await input.click();
  await input.fill("");
  await wait(300);
  const stale = await listText();
  await input.fill(address);
  let seen = "";
  for (let i = 0; i < ADDRESS_POLL.attempts; i++) {
    await wait(ADDRESS_POLL.intervalMs);
    const now = await listText();
    if (now && now !== stale && now === seen) break;
    seen = now;
  }
  if (!seen || seen === stale) return false;
  await options.first().click();
  await wait(700);
  return true;
}

const ADDRESS_POLL = { attempts: 24, intervalMs: 250 };

/** Ждать, пока `check` не вернёт true; не дождались — false. */
export async function waitFor(check: () => Promise<boolean>, attempts = 30, intervalMs = 500): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    if (await check().catch(() => false)) return true;
    await wait(intervalMs);
  }
  return false;
}
