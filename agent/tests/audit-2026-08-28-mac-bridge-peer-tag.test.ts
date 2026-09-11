/**
 * Аудит 2026-08-28: в логе неудачной авторизации не было ничего, что можно
 * сопоставить.
 *
 * extractPortOnly брала `ws.remoteAddress` и возвращала хвост после
 * последнего двоеточия — «IP это PII, но какой-то сигнал для корреляции нам
 * нужен», как написано в её собственном докблоке. Только Bun отдаёт в
 * `ServerWebSocket.remoteAddress` голый адрес БЕЗ порта (проверено живым
 * `Bun.serve` в «предпосылках» ниже): для IPv4 двоеточия там нет вовсе,
 * `lastIndexOf(":")` даёт -1, и функция возвращает `"?"` — всегда, на любом
 * пире. То есть в проде строка выглядела ровно так:
 *
 *     [mac-bridge] auth_fail token=<len=7 last4=cret> from=:?
 *
 * Сигнала ноль: сто попыток с одного адреса и сто с разных выглядят
 * одинаково, а именно перебор эта запись и должна была ловить. Для IPv6
 * (`::1`) было хуже, чем ноль: возвращалась `"1"` — кусок адреса, выданный
 * за порт.
 *
 * Порта в этом месте нет и не будет, поэтому корреляцию даёт не он, а
 * `peerKey` — адрес, который сокет и так носит в `ws.data` для учёта лимита
 * соединений. В лог он идёт солёным хэшем: одинаковые пиры дают одинаковый
 * тег, разные — разный, а сам адрес из тега не достаётся. Соль случайная и
 * живёт один процесс, так что тег не связывается с IP и после утечки лога.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { peerTag } from "../lib/mac-bridge.ts";

const SRC = readFileSync(new URL("../lib/mac-bridge.ts", import.meta.url), "utf-8");

/** Форма ровно такая, какую отдаёт Bun: адрес без порта + data с peerKey. */
function sock(ip: string): unknown {
  return { remoteAddress: ip, data: { authed: false, peerKey: ip } };
}

describe("предпосылки", () => {
  test("Bun не кладёт порт в remoteAddress — там голый адрес", async () => {
    // Причина всей правки: тянуть порт неоткуда, он до обработчика не доезжает.
    let seen = "";
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (req, srv) => (srv.upgrade(req) ? undefined : new Response("no")),
      websocket: {
        open(ws) {
          seen = String((ws as unknown as { remoteAddress: string }).remoteAddress);
          ws.close();
        },
        message() {},
      },
    });
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/`);
    await new Promise<void>((resolve) => {
      ws.addEventListener("close", () => resolve());
      ws.addEventListener("error", () => resolve());
    });
    server.stop(true);
    expect(seen).toBe("127.0.0.1");
    expect(seen).not.toContain(":");
  });
});

describe("peerTag", () => {
  test("один и тот же пир даёт один и тот же тег", () => {
    expect(peerTag(sock("203.0.113.7"))).toBe(peerTag(sock("203.0.113.7")));
  });

  test("разные пиры дают разные теги", () => {
    const tags = new Set(
      ["203.0.113.7", "203.0.113.8", "198.51.100.4", "::1"].map((ip) => peerTag(sock(ip))),
    );
    expect(tags.size).toBe(4);
  });

  test("IPv6 не превращается в «порт» из куска адреса", () => {
    // Прежняя резка по последнему двоеточию возвращала здесь "1".
    const tag = peerTag(sock("::1"));
    expect(tag).not.toBe("1");
    expect(tag).toMatch(/^p_[0-9a-f]{8}$/);
  });

  test("адрес в тег не протекает", () => {
    for (const ip of ["203.0.113.7", "2001:db8::42"]) {
      const tag = peerTag(sock(ip));
      expect(tag).not.toContain(ip);
      for (const part of ip.split(/[.:]/).filter((p) => p.length >= 3)) {
        expect(tag).not.toContain(part);
      }
    }
  });

  test("формат тега короткий и однозначный", () => {
    expect(peerTag(sock("203.0.113.7"))).toMatch(/^p_[0-9a-f]{8}$/);
  });

  test("нечего сопоставлять — честный «?», а не тег от заглушки", () => {
    // `unknown` пишет сам мост, когда requestIP ничего не дал: тег от этой
    // строки был бы одинаков у всех таких соединений и выглядел бы как пир.
    expect(peerTag({ data: { authed: false, peerKey: "unknown" } })).toBe("?");
    expect(peerTag({ data: { authed: false, peerKey: "" } })).toBe("?");
  });

  test("мусор на входе не роняет лог", () => {
    for (const bad of [null, undefined, {}, { data: {} }, { data: null }, 42, "1.2.3.4"]) {
      expect(peerTag(bad)).toBe("?");
    }
  });
});

describe("применение", () => {
  test("лог auth_fail пишет тег пира, а не пустой порт", () => {
    expect(SRC).toContain("peer=${peerTag(ws)}");
    expect(SRC).not.toContain("from=:${portOnly}");
  });

  test("прежней резки по двоеточию не осталось", () => {
    const code = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toContain("extractPortOnly");
    expect(code).not.toContain("lastIndexOf(\":\")");
  });

  test("соль случайная, а не константа в исходнике", () => {
    // Захардкоженная соль вернула бы тегу обратимость: словарь всех IPv4
    // строится за секунды.
    expect(SRC).toContain("randomBytes(16)");
  });
});
