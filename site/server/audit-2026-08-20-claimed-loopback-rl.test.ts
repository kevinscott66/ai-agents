/**
 * Аудит 2026-08-20: заголовок мог занести клиента в привилегированный пул.
 *
 * `SHARED_LOCAL_KEYS` (index.ts:141) — ведро для случая «клиентской
 * идентичности нет вовсе»: .ton-трафик приходит с петли и без XFF, и владелец
 * на VPS поднимает ему ёмкость до 600 через SITE_LOOPBACK_RL_CAPACITY.
 *
 * Но гейт доверия к заголовку — «сокет пришёл с петли» — за nginx выполняется
 * ВСЕГДА, а значение `clientIpKey` брал как есть. Запрос
 * `CF-Connecting-IP: 127.0.0.1` → ключ `ip:127.0.0.1` → ёмкость 600 вместо 60,
 * и она же общая с ton-прокси, то есть посторонний может её выпить.
 *
 * Через Cloudflare или внешний nginx адрес 127.0.0.1 прийти не может — такое
 * утверждение бессмысленно по построению. Сводим все его формы в один ключ
 * обычной ёмкости.
 *
 * Это вторая линия обороны. Первая — vhost: сам заголовок обязан
 * перезаписываться (`set_real_ip_from` для сетей прокси + `real_ip_header`),
 * иначе клиент задаёт ключ лимитера сам. Из кода конфиг не виден, поэтому при
 * старте с непустым SITE_CLIENT_IP_HEADER сервер печатает предупреждение.
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  clientIpKey,
  CLAIMED_LOOPBACK_KEY,
  _rateLimitOk,
  _resetRateLimiter,
} from "./index.ts";

const LOOPBACK_FORMS = ["127.0.0.1", "::1", "::ffff:127.0.0.1"];

describe("адрес из заголовка не попадает в общий локальный пул", () => {
  beforeEach(() => _resetRateLimiter());

  for (const form of LOOPBACK_FORMS) {
    test(`заголовок с «${form}» не даёт ключ настоящей петли`, () => {
      const claimed = clientIpKey(null, "127.0.0.1", form);
      // До правки здесь возвращалось ровно `ip:${form}` — ключ пула на 600.
      expect(claimed).toBe(CLAIMED_LOOPBACK_KEY);
      expect(claimed).not.toBe(`ip:${form}`);
      expect(claimed).not.toBe(clientIpKey(null, "127.0.0.1"));
    });

    test(`последний хоп XFF «${form}» — то же самое`, () => {
      expect(clientIpKey(`8.8.8.8, ${form}`, "127.0.0.1")).toBe(
        CLAIMED_LOOPBACK_KEY,
      );
    });
  }

  test("настоящий ADNL-трафик (петля, без заголовков) пул не теряет", () => {
    // Ровно тот случай, ради которого пул и заведён: tonutils-reverse-proxy
    // ходит с петли и не шлёт ни XFF, ни заголовок владельца.
    expect(clientIpKey(null, "127.0.0.1")).toBe("ip:127.0.0.1");
    expect(clientIpKey(null, "::1")).toBe("ip:::1");
  });

  test("обычные адреса из заголовка проходят как были", () => {
    expect(clientIpKey(null, "127.0.0.1", "203.0.113.7")).toBe("ip:203.0.113.7");
    expect(clientIpKey("1.2.3.4, 203.0.113.8", "127.0.0.1")).toBe(
      "ip:203.0.113.8",
    );
  });
});

describe("ёмкость: заявленная петля не получает пул на 600", () => {
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env.SITE_LOOPBACK_RL_CAPACITY;
    process.env.SITE_LOOPBACK_RL_CAPACITY = "600";
    _resetRateLimiter();
  });

  afterEach(() => {
    // CLAUDE.md §3.8.7: env обязан вернуться, иначе течёт в соседние тесты.
    if (saved === undefined) delete process.env.SITE_LOOPBACK_RL_CAPACITY;
    else process.env.SITE_LOOPBACK_RL_CAPACITY = saved;
    _resetRateLimiter();
  });

  function drain(key: string, n: number): number {
    let ok = 0;
    for (let i = 0; i < n; i++) if (_rateLimitOk(key)) ok++;
    return ok;
  }

  test("настоящая петля — 600, заявленная — 60", () => {
    expect(drain(clientIpKey(null, "127.0.0.1"), 200)).toBe(200);
    _resetRateLimiter();
    const claimed = clientIpKey(null, "127.0.0.1", "127.0.0.1");
    // До правки claimed === "ip:127.0.0.1" и здесь тоже было бы 200.
    expect(drain(claimed, 200)).toBeLessThanOrEqual(61);
  });

  test("выпитое чужаком ведро не задевает ни ton-пул, ни обычного гостя", () => {
    expect(drain(clientIpKey(null, "127.0.0.1", "::1"), 200)).toBeLessThanOrEqual(
      61,
    );
    expect(_rateLimitOk(clientIpKey(null, "127.0.0.1"))).toBe(true);
    expect(_rateLimitOk(clientIpKey(null, "127.0.0.1", "203.0.113.7"))).toBe(
      true,
    );
  });
});
