/**
 * Аудит 2026-08-20: компактор терял память хода из-за жадной регулярки.
 *
 * `extractJSON` брал кусок от ПЕРВОЙ `{` до ПОСЛЕДНЕЙ `}` во всём ответе
 * модели. Ответ обычно голый JSON — тогда это верно. Но SYSTEM компактора
 * состоит из примеров вида {"op":"noop"}, и модель охотно повторяет их в
 * пояснении до или после результата. Одна такая скобка — и склеенный кусок
 * перестаёт быть валидным JSON: `JSON.parse` кидает, `runCompactor` пишет одну
 * warn-строку и выходит. Вызов fire-and-forget, повтора нет — всё, что агент
 * решил запомнить за ход, исчезает без следа.
 *
 * Проверяем разбор, а не поведение модели: границы объекта, скобки внутри
 * строк, экранирование и то, что негодный вход по-прежнему уходит в warn-путь,
 * а не в тихий null.
 */
import { describe, test, expect } from "bun:test";
import { _compactorInternals } from "../lib/compactor.ts";

const { extractJSON, matchBrace } = _compactorInternals;

/** Извлечь и распарсить — как это делает runCompactor. */
function ops(text: string): unknown[] | null {
  const json = extractJSON(text);
  if (!json) return null;
  return (JSON.parse(json) as { ops: unknown[] }).ops;
}

describe("matchBrace", () => {
  test("простой объект", () => {
    const s = '{"a":1}';
    expect(matchBrace(s, 0)).toBe(s.length - 1);
  });

  test("вложенность считается по глубине", () => {
    const s = '{"a":{"b":{}}}';
    expect(matchBrace(s, 0)).toBe(s.length - 1);
  });

  test("закрывающая скобка внутри строки не закрывает объект", () => {
    const s = '{"line":"итог: } готово"}';
    expect(matchBrace(s, 0)).toBe(s.length - 1);
  });

  test("экранированная кавычка не выводит из строки", () => {
    const s = '{"line":"он сказал \\"} всё\\""}';
    expect(matchBrace(s, 0)).toBe(s.length - 1);
  });

  test("незакрытый объект — -1", () => {
    expect(matchBrace('{"a":1', 0)).toBe(-1);
  });

  test("незакрытая строка съедает остаток — -1", () => {
    expect(matchBrace('{"a":"хвост}', 0)).toBe(-1);
  });
});

describe("extractJSON", () => {
  test("голый ответ разбирается", () => {
    expect(ops('{"ops":[{"op":"noop"}]}')).toEqual([{ op: "noop" }]);
  });

  test("пояснение ПОСЛЕ json больше не склеивается", () => {
    // Ровно то, что ломало прод: хвост с примером из системного промпта.
    const text =
      '{"ops":[{"op":"team_log","line":"решили катить в пятницу"}]}\n\n' +
      'Если писать нечего — верни {"op":"noop"}.';
    expect(ops(text)).toEqual([
      { op: "team_log", line: "решили катить в пятницу" },
    ]);
  });

  test("пример ДО json не перехватывает разбор", () => {
    const text =
      'Формат операции — {"op":"team_log","line":"…"}. Результат:\n' +
      '{"ops":[{"op":"private_log","line":"надо перечитать ADR-0007"}]}';
    expect(ops(text)).toEqual([
      { op: "private_log", line: "надо перечитать ADR-0007" },
    ]);
  });

  test("незакрытая скобка в прозе не отменяет настоящий объект", () => {
    // Из-за неё нельзя обрывать поиск на первой неудаче.
    const text = 'Формат {"op":"noop" ... а вот итог: {"ops":[{"op":"noop"}]}';
    expect(ops(text)).toEqual([{ op: "noop" }]);
  });

  test("markdown-фенс вокруг json", () => {
    const text = '```json\n{"ops":[{"op":"noop"}]}\n```';
    expect(ops(text)).toEqual([{ op: "noop" }]);
  });

  test("фигурные скобки внутри content не рвут объект", () => {
    const text =
      '{"ops":[{"op":"upsert_team_page","slug":"projects/x","title":"X",' +
      '"content":"пример: {\\"op\\":\\"noop\\"} — так не надо"}]}';
    const parsed = ops(text) as { content: string }[] | null;
    expect(parsed).not.toBeNull();
    expect(parsed![0].content).toContain('{"op":"noop"}');
  });

  test("пустой массив ops — валидный ответ", () => {
    expect(ops('{"ops":[]}')).toEqual([]);
  });

  test("берётся первый объект с ops, а не последний", () => {
    const text = '{"ops":[{"op":"noop"}]}\n{"ops":[{"op":"team_log","line":"x"}]}';
    expect(ops(text)).toEqual([{ op: "noop" }]);
  });

  test("объект без ops не выдаётся за результат, но и не молчит", () => {
    // Фолбэк на старый жадный кусок: вызывающий увидит его, распарсит и
    // выйдет по ветке «no ops array» с warn'ом — а не по тихому null.
    const text = '{"type":"team_log","line":"дрейф схемы"}';
    const json = extractJSON(text);
    expect(json).toBe(text);
    expect((JSON.parse(json!) as { ops?: unknown }).ops).toBeUndefined();
  });

  test("экранированный обратный слеш перед кавычкой строку ЗАКРЫВАЕТ", () => {
    // Перенесено из ветки fix/compactor-greedy-json (PR #600, закрыт как
    // дубль): `"путь\\"` — слеш экранирован, значит кавычка настоящая. Если
    // из matchBrace убрать сброс `esc`, сканер сочтёт её экранированной и
    // утечёт до конца текста — то есть вернётся ровно та потеря батча,
    // против которой всё это написано.
    // Проза с обеих сторон здесь обязательна, а не для красоты: на голом
    // JSON сломанный matchBrace незаметен — extractJSON не найдёт кандидата,
    // упадёт в жадный фолбэк, а тот на голом ответе как раз прав. Дефект
    // виден только там, где фолбэк тоже врёт, то есть в реальной форме.
    const text =
      'Формат {ops}. Результат:\n' +
      '{"ops":[{"op":"team_log","line":"путь\\\\"}]}\n' +
      'Готово {конец}.';
    const parsed = ops(text) as { line: string }[] | null;
    expect(parsed).not.toBeNull();
    expect(parsed![0].line).toBe("путь\\");
  });

  test("текст без единой скобки — null", () => {
    expect(extractJSON("нечего записывать")).toBeNull();
  });

  test("оборванный json — не null, уходит в warn-путь", () => {
    // Обрезка по max_tokens: объект не закрылся. Прежнее поведение (жадный
    // кусок или null) сохраняем — важно, что не бросаем исключение.
    const text = '{"ops":[{"op":"team_log","line":"длинн';
    expect(() => extractJSON(text)).not.toThrow();
    expect(extractJSON(text)).toBeNull();
  });
});
