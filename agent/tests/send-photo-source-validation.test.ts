/**
 * Аудит 2026-08-11: у SEND_PHOTO обложка не проверялась ничем.
 *
 * 2026-08-07 ровно эти два поля закрыли у PUBLISH_TO_CHANNEL, и комментарий там
 * до сих пор описывает механику дословно: «photoUrl уходил в Telegram любой
 * строкой, photoBase64 — в Buffer.from(x,"base64"), а он молча выбрасывает
 * мусорные символы и на кривом входе отдаёт пустой буфер». Обе проверки
 * (`validatePhotoUrl`, `normalizePhotoBase64`) написаны и лежат в том же файле.
 *
 * SEND_PHOTO принимает те же `url`/`base64` и не звал ни одну. Причём это путь
 * БЕЗ апрува (SEND_PHOTO намеренно не в SEMI_AUTO_RISKY — exfil там закрыт
 * пиннингом чата), то есть агент отправляет картинку сам, и единственная
 * обратная связь о поломке — 400 от Telegram.
 *
 * Что ломалось на самом деле:
 *  • `data:image/png;base64,iVBOR…` — модели ставят префикс постоянно, о чём
 *    прямо сказано в комментарии к normalizePhotoBase64. Buffer.from режет его
 *    как мусор и отдаёт СМЕЩЁННЫЙ буфер: не ошибка, а битая картинка.
 *  • Строка не из base64 вовсе → пустой буфер → «фото» нулевого размера.
 *  • Ни одного ограничения на размер: 10-мегабайтный лимит Telegram знал
 *    только соседний путь.
 *
 * Инвариант: одна и та же картинка проверяется одинаково, каким бы действием
 * её ни слали.
 */
import { describe, test, expect } from "bun:test";
import { buildPayload, MAX_PHOTO_BYTES } from "../lib/dispatch/build-payload.ts";

const CTX = { agentKey: "design" };

function build(input: Record<string, unknown>) {
  return buildPayload("SEND_PHOTO", input, CTX);
}

describe("SEND_PHOTO: url проверяется так же, как photoUrl у публикации", () => {
  test("не-URL отклоняется", () => {
    const r = build({ url: "картинка.png" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("не URL");
  });

  test("file:/data: схемы отклоняются", () => {
    for (const url of ["file:///etc/passwd", "data:image/png;base64,iVBORw0KGgo="]) {
      const r = build({ url });
      expect(r.ok).toBe(false);
    }
  });

  test("обычный https проходит", () => {
    const r = build({ url: "https://example.com/a.png", caption: "x" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.payload.source).toEqual({ url: "https://example.com/a.png" });
  });
});

describe("SEND_PHOTO: base64 нормализуется так же, как photoBase64", () => {
  const PNG_1PX =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

  test("data:-префикс снимается, а не режется как мусор", () => {
    const r = build({ base64: `data:image/png;base64,${PNG_1PX}` });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.payload.source).toEqual({ base64: PNG_1PX });
    // Смысл проверки: без неё Buffer.from съел бы префикс посимвольно и отдал
    // смещённый буфер — не ошибку, а битую картинку.
    expect(Buffer.from((r.payload.source as { base64: string }).base64, "base64")
      .subarray(0, 4).toString("hex")).toBe("89504e47");
  });

  test("строка не из base64 отклоняется, а не превращается в пустой буфер", () => {
    const r = build({ base64: "это точно не картинка!!!" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("base64");
  });

  test("лимит Telegram в 10 МБ проверяется до отправки", () => {
    const tooBig = "A".repeat(Math.ceil(((MAX_PHOTO_BYTES + 1_000_000) * 4) / 3));
    const r = build({ base64: tooBig });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("10 МБ");
  });

  test("чистый base64 проходит без изменений", () => {
    const r = build({ base64: PNG_1PX });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.payload.source).toEqual({ base64: PNG_1PX });
  });
});

describe("прежние правила SEND_PHOTO не тронуты", () => {
  test("нужно ровно одно из url/base64", () => {
    expect(build({}).ok).toBe(false);
    expect(build({ url: "https://example.com/a.png", base64: "iVBORw0KGgo=" }).ok).toBe(
      false,
    );
  });
});
