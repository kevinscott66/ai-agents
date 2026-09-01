/**
 * Аудит 2026-08-12: лимитер считал всех посетителей сайта одним клиентом.
 *
 * `clientIp()` предпочитал сокетный peer безусловно. Сайт живёт за nginx
 * (vhost → Bun на 8790, .claude/memory/notes/delabs-content-system.md:10),
 * то есть peer — ВСЕГДА 127.0.0.1, и ведро на 60 токенов/мин одно на всю
 * площадку. Главная при этом дёргает /api пять раз: StatsBar + четыре секции
 * (pages/HomePage.tsx:34-39).
 *
 * Замер старой логики (зонд, дословная копия clientIp + rateLimitOk):
 *   ключей вёдер на 20 разных посетителей: 1
 *   20 посетителей × 5 запросов главной: ok=60 429=40, первый 429 у #13
 *   то есть вся площадка укладывается в 12 загрузок главной в минуту
 *   ключ при подделанном левом элементе XFF: 127.0.0.1 (XFF не смотрится вовсе)
 *
 * Верхняя половина комментария при этом была верна по сути: левому элементу
 * XFF верить нельзя, `proxy_add_x_forwarded_for` ДОПИСЫВАЕТ remote_addr к
 * присланному клиентом. Правильный разбор уже написан и объяснён в
 * agent/lib/http-utils.ts:354-380 (`clientIpKey`) — здесь он же, местной
 * копией: site/server отдельный пакет и в agent/ не ходит.
 *
 * Инвариант: за прокси ключ берётся из последнего элемента XFF, при прямом
 * обращении — из peer, подделанное начало XFF не влияет ни в одном случае.
 *
 * Уточнение 2026-08-12: «последний» верно ровно для одного своего прокси.
 * Если перед Bun встанет второй (Cloudflare → nginx), последним окажется адрес
 * первого прокси, и вся площадка снова схлопнется в одно ведро. Число своих
 * хопов вынесено в `SITE_TRUSTED_PROXY_HOPS` (по умолчанию 1 — ровно нынешнее
 * поведение); проверки на значения > 1 живут в audit-2026-08-12.test.ts.
 */
import { describe, expect, test, beforeEach } from "bun:test";
import { clientIpKey, _rateLimitOk, _resetRateLimiter } from "./index.ts";

describe("ключ ведра лимитера", () => {
  test("за nginx разные посетители — разные ключи", () => {
    const a = clientIpKey("203.0.113.7", "127.0.0.1");
    const b = clientIpKey("203.0.113.8", "127.0.0.1");
    expect(a).not.toBe(b);
    // Старое поведение: оба «127.0.0.1».
    expect(a).not.toBe("127.0.0.1");
  });

  test("подделанное начало XFF игнорируется — берём последний хоп", () => {
    // Клиент прислал «1.2.3.4», nginx дописал свой remote_addr справа.
    expect(clientIpKey("1.2.3.4, 203.0.113.9", "127.0.0.1")).toBe(
      clientIpKey("9.9.9.9, 203.0.113.9", "127.0.0.1"),
    );
    expect(clientIpKey("1.2.3.4, 203.0.113.9", "127.0.0.1")).not.toBe(
      clientIpKey("1.2.3.4, 203.0.113.10", "127.0.0.1"),
    );
  });

  test("прямое обращение снаружи: XFF не смотрим вовсе", () => {
    // peer не локальный — заголовок пришёл от самого клиента, доверия нет.
    expect(clientIpKey("1.2.3.4", "198.51.100.5")).toBe(
      clientIpKey(null, "198.51.100.5"),
    );
    expect(clientIpKey("1.2.3.4", "198.51.100.5")).not.toBe(
      clientIpKey("1.2.3.4", "198.51.100.6"),
    );
  });

  test("IPv6-формы петли тоже считаются прокси", () => {
    for (const peer of ["::1", "::ffff:127.0.0.1"]) {
      expect(clientIpKey("203.0.113.7", peer)).toBe(
        clientIpKey("203.0.113.7", "127.0.0.1"),
      );
    }
  });

  test("за прокси без XFF ключ всё же есть — падать некуда", () => {
    expect(clientIpKey(null, "127.0.0.1")).toBeString();
    expect(clientIpKey("", "127.0.0.1")).toBeString();
    expect(clientIpKey(null, null)).toBeString();
  });
});

describe("трафик главной страницы", () => {
  beforeEach(() => _resetRateLimiter());

  test("20 посетителей по одной загрузке главной — ни одного 429", () => {
    let ok = 0;
    let blocked = 0;
    for (let v = 1; v <= 20; v++) {
      for (let c = 0; c < 5; c++) {
        if (_rateLimitOk(clientIpKey(`203.0.113.${v}`, "127.0.0.1"))) ok++;
        else blocked++;
      }
    }
    // Старое поведение: ok=60 429=40, первый отказ на 13-м посетителе.
    expect(blocked).toBe(0);
    expect(ok).toBe(100);
  });

  test("шумный клиент упирается в лимит один, соседа не задевает", () => {
    const noisy = clientIpKey("203.0.113.1", "127.0.0.1");
    let blocked = 0;
    for (let i = 0; i < 80; i++) if (!_rateLimitOk(noisy)) blocked++;
    expect(blocked).toBeGreaterThan(0);
    expect(_rateLimitOk(clientIpKey("203.0.113.2", "127.0.0.1"))).toBe(true);
  });
});
