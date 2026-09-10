/**
 * Аудит 2026-09-10: карточка аппрува PUBLISH_TO_CHANNEL не называла ни канал,
 * ни картинку.
 *
 * Аппрув существует затем, чтобы человек посмотрел на содержимое ДО
 * необратимого действия (докблок `approvalPreview`). Для публикации содержимое
 * — это три вещи: текст, канал и картинка. В карточку попадала одна: общий
 * путь `PREVIEW_FIELDS` берёт только строковые поля, а `channelId` — число
 * (ровно тот разбор, по которому аудит 2026-08-29 завёл рендереры
 * DELETE/PIN/FORWARD), картинка же лежит в `photoUrl`/`photoBase64`/
 * `coverTitle`, которых в списке нет вовсе.
 *
 * Цена промаха разная у двух половин: не тот канал — пост под именем команды
 * уходит не той аудитории; не та картинка — в канал уходит изображение по
 * URL или base64 от модели, которое владелец не видел и одобрить не мог.
 */
import { describe, test, expect } from "bun:test";
import { approvalPreview } from "../lib/approvals.ts";

const LONG = "Криптоиндустрия за неделю: ".repeat(20);

describe("approvalPreview: PUBLISH_TO_CHANNEL", () => {
  test("канал назван и не вытесняется длинным постом", () => {
    const s = approvalPreview("PUBLISH_TO_CHANNEL", { channelId: -1002233, text: LONG });
    expect(s).toContain("канал -1002233");
    // Тот самый порядок: пост режется на 120 символах, поэтому канал обязан
    // стоять до него, иначе в карточке его не будет никогда.
    expect(s.indexOf("канал")).toBeLessThan(s.indexOf("Крипто"));
  });

  test("чужая картинка по ссылке названа ссылкой", () => {
    const s = approvalPreview("PUBLISH_TO_CHANNEL", {
      channelId: 42,
      text: "пост",
      photoUrl: "https://example.invalid/x.png",
    });
    expect(s).toContain("https://example.invalid/x.png");
  });

  test("готовый base64 назван, а не выдан за баннер", () => {
    const s = approvalPreview("PUBLISH_TO_CHANNEL", {
      channelId: 42,
      text: "пост",
      photoBase64: "iVBORw0KGgo=",
    });
    expect(s).toContain("готовый файл");
    // Содержимого base64 в карточке быть не должно: это не текст для чтения.
    expect(s).not.toContain("iVBORw0KGgo");
  });

  test("порядок ветвей совпадает с publish.ts: photoUrl перебивает coverTitle", () => {
    const s = approvalPreview("PUBLISH_TO_CHANNEL", {
      channelId: 42,
      text: "пост",
      photoUrl: "https://example.invalid/x.png",
      coverTitle: "не будет использован",
    });
    expect(s).toContain("https://example.invalid/x.png");
    expect(s).not.toContain("не будет использован");
  });

  test("без единого поля картинки карточка всё равно о ней говорит", () => {
    // Баннер рисуется по заголовку поста — то есть картинка будет всегда.
    const s = approvalPreview("PUBLISH_TO_CHANNEL", { channelId: 42, text: "пост" });
    expect(s).toContain("баннер");
  });

  test("текст поста из карточки не пропал", () => {
    const s = approvalPreview("PUBLISH_TO_CHANNEL", { channelId: 42, text: "коротко о главном" });
    expect(s).toContain("коротко о главном");
  });
});
