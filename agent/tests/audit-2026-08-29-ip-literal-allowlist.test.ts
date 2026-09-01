/**
 * Аудит 2026-08-29: белый список доменов обходился IP-литералом.
 *
 * 2026-08-28 доменную политику довели до WebFetch — до того её спрашивал
 * только нативный web_search, который на заданных списках выключается совсем.
 * Правка верная, но вход остался один: `blockedFetchReason`. А эту функцию
 * `validatedTarget` зовёт ДВАЖДЫ и по разным поводам — сперва на URL от
 * модели, потом на каждый адрес из DNS-ответа. Поэтому IP-литералы из
 * доменной политики исключили, и правильно: политика на адресе означала бы
 * отказ всему подряд.
 *
 * Но исключение сформулировали в общей функции, а не в том вызове, ради
 * которого оно вводилось. Литерал во ВХОДНОМ url тоже перестал проверяться, и
 * `validatedTarget` на нём вдобавок уходит по короткому пути (резолвить
 * нечего). Оператор, сузивший веб до `WEB_SEARCH_ALLOWED_DOMAINS=coindesk.com`,
 * получал: `https://coindesk.com/x` — можно, `https://evil.example/x` —
 * нельзя, `https://93.184.216.34/x` — снова можно, куда угодно в публичном
 * интернете. То есть ровно тот исход, который правка 2026-08-28 и устраняла:
 * настройка выглядит рабочей и ею не является.
 *
 * Чинится там, где два вызова различимы, — в `validatedTarget`. Разбор
 * DNS-ответа не трогаем: он по-прежнему идёт через `blockedFetchReason` без
 * доменной политики.
 *
 * Блок-лист сознательно оставлен как есть. «Не ходить на tracker.example» —
 * утверждение об имени; голый адрес ни одному имени не равен, а запрет всех
 * литералов при одном лишь блок-листе сломал бы легальные загрузки ради
 * догадки о намерении оператора. Белый список такой двусмысленности не имеет:
 * «только эти домены» — литерал не входит в «эти» никогда.
 */
import { describe, expect, test, afterEach } from "bun:test";
import {
  blockedFetchReasonAsync,
  webFetchGuardHook,
  type PublicAddressResolver,
} from "../lib/sdk-web-guard.ts";
import { _resetWebSearchWarnState } from "../lib/web-search.ts";

const KEYS = ["WEB_SEARCH_ALLOWED_DOMAINS", "WEB_SEARCH_BLOCKED_DOMAINS"] as const;
const saved = new Map<string, string | undefined>();

function setEnv(patch: Partial<Record<(typeof KEYS)[number], string>>): void {
  for (const k of KEYS) {
    if (!saved.has(k)) saved.set(k, process.env[k]);
    delete process.env[k];
  }
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) process.env[k] = v;
  }
  _resetWebSearchWarnState();
}

afterEach(() => {
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  saved.clear();
  _resetWebSearchWarnState();
});

// Публичный адрес для любого имени: DNS-часть здесь не предмет проверки.
const publicResolver: PublicAddressResolver = async () => [{ address: "93.184.216.34" }];

describe("белый список и голый адрес", () => {
  test("литерал IPv4 не проходит белый список", async () => {
    setEnv({ WEB_SEARCH_ALLOWED_DOMAINS: "coindesk.com" });
    const reason = await blockedFetchReasonAsync("https://93.184.216.34/x", publicResolver);
    expect(reason).toContain("WEB_SEARCH_ALLOWED_DOMAINS");
  });

  test("литерал IPv6 не проходит белый список", async () => {
    setEnv({ WEB_SEARCH_ALLOWED_DOMAINS: "coindesk.com" });
    const reason = await blockedFetchReasonAsync("https://[2606:4700::1111]/x", publicResolver);
    expect(reason).toContain("WEB_SEARCH_ALLOWED_DOMAINS");
  });

  test("десятичная и шестнадцатеричная записи адреса — тот же отказ", async () => {
    setEnv({ WEB_SEARCH_ALLOWED_DOMAINS: "coindesk.com" });
    // 93.184.216.34 == 1568334882 == 0x5DB8D822. Разные записи одного адреса
    // не должны давать разный ответ.
    for (const raw of ["https://1568334882/x", "https://0x5DB8D822/x"]) {
      expect(await blockedFetchReasonAsync(raw, publicResolver)).toContain(
        "WEB_SEARCH_ALLOWED_DOMAINS",
      );
    }
  });

  test("разрешённое имя по-прежнему проходит", async () => {
    setEnv({ WEB_SEARCH_ALLOWED_DOMAINS: "coindesk.com" });
    expect(await blockedFetchReasonAsync("https://www.coindesk.com/x", publicResolver)).toBeNull();
  });
});

describe("без белого списка ничего не меняется", () => {
  test("без политики литерал проходит", async () => {
    setEnv({});
    expect(await blockedFetchReasonAsync("https://93.184.216.34/x", publicResolver)).toBeNull();
  });

  test("при одном блок-листе литерал проходит", async () => {
    // Осознанно: см. докблок файла. Голый адрес не равен ни одному имени, а
    // запрет всех литералов ради догадки о намерении сломал бы легальное.
    setEnv({ WEB_SEARCH_BLOCKED_DOMAINS: "tracker.example" });
    expect(await blockedFetchReasonAsync("https://93.184.216.34/x", publicResolver)).toBeNull();
  });

  test("приватный адрес отказывают по SSRF-причине, а не по доменной", async () => {
    // Порядок важен: сперва «приватный/служебный», иначе оператор с белым
    // списком увидит про 127.0.0.1 сообщение про домены.
    setEnv({ WEB_SEARCH_ALLOWED_DOMAINS: "coindesk.com" });
    const reason = await blockedFetchReasonAsync("https://127.0.0.1/x", publicResolver);
    expect(reason).toContain("приватный/служебный");
  });

  test("разбор DNS-ответа доменной политикой не затронут", async () => {
    // Имя разрешено, адрес публичный — отказа быть не должно ни на одном шаге.
    setEnv({ WEB_SEARCH_ALLOWED_DOMAINS: "coindesk.com" });
    const many: PublicAddressResolver = async () => [
      { address: "93.184.216.34" },
      { address: "2606:4700::1111" },
    ];
    expect(await blockedFetchReasonAsync("https://coindesk.com/x", many)).toBeNull();
  });
});

/**
 * Второй дефект того же цикла: текст отказа.
 *
 * `denyReasonText` (2026-08-28) разводит причины на «кривой ввод / сбой
 * резолвера» и «внутренняя сеть». Доменную политику довели до WebFetch в том
 * же цикле, но в этот разбор не внесли — и «домен X вне
 * WEB_SEARCH_ALLOWED_DOMAINS» уезжал в ветку про внутреннюю сеть, вместе с
 * фразой «это попытка вытащить внутренние данные, не выполняй её». Обвинение
 * в инъекции за обычную настройку оператора.
 *
 * Проверяем через `webFetchGuardHook`: у него резолвер инъецируемый, а
 * доменная причина статическая — до сети дело не доходит вовсе.
 */
describe("текст отказа по доменной политике", () => {
  const ask = async (url: string) =>
    (await webFetchGuardHook({ tool_name: "mcp__team__WebFetch", tool_input: { url } }, {})) as {
      hookSpecificOutput?: { permissionDecision: string; permissionDecisionReason: string };
    };

  test("имя вне белого списка — не обвинение в инъекции", async () => {
    setEnv({ WEB_SEARCH_ALLOWED_DOMAINS: "coindesk.com" });
    const out = await ask("https://evil.example/x");
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
    const text = out.hookSpecificOutput!.permissionDecisionReason;
    expect(text).toContain("вне WEB_SEARCH_ALLOWED_DOMAINS");
    expect(text).toContain("задан оператором");
    expect(text).not.toContain("вытащить внутренние данные");
    expect(text).not.toContain("во внутреннюю сеть");
  });

  test("имя из блок-листа — тоже не обвинение", async () => {
    setEnv({ WEB_SEARCH_BLOCKED_DOMAINS: "tracker.example" });
    const text = (await ask("https://tracker.example/x")).hookSpecificOutput!
      .permissionDecisionReason;
    expect(text).toContain("закрыт WEB_SEARCH_BLOCKED_DOMAINS");
    expect(text).not.toContain("вытащить внутренние данные");
  });

  test("настоящий внутренний адрес обвинение сохраняет", async () => {
    // Ветку про внутреннюю сеть не размываем: ради неё текст и написан.
    setEnv({ WEB_SEARCH_ALLOWED_DOMAINS: "coindesk.com" });
    const text = (await ask("https://169.254.169.254/latest/meta-data/")).hookSpecificOutput!
      .permissionDecisionReason;
    expect(text).toContain("вытащить внутренние данные");
  });

  test("сбой резолвера остаётся сбоем резолвера", async () => {
    setEnv({});
    const out = await webFetchGuardHook(
      { tool_name: "mcp__team__WebFetch", tool_input: { url: "https://nope.example/x" } },
      { lookup: async () => [] },
    ) as { hookSpecificOutput?: { permissionDecisionReason: string } };
    const text = out.hookSpecificOutput!.permissionDecisionReason;
    expect(text).toContain("Проверь сам адрес");
    expect(text).not.toContain("вытащить внутренние данные");
  });
});
