/**
 * Первая ступень загрузочной лестницы Mini App — и единственное место, где
 * живёт `debug`.
 *
 * Модуль намеренно без импортов. Порядок вычисления модулей в ES — это порядок
 * их импортов в обход графа зависимостей; у листа зависимостей нет, поэтому
 * лист, импортированный первым, выполняется раньше всего остального бандла.
 * Ровно это здесь и нужно.
 *
 * Аудит 2026-08-20: до него вызов стоял statement'ом ВЫШЕ блока `import` в
 * main.tsx. `import` — декларация, а не statement: весь граф зависимостей
 * (preact, App, styles, theme) вычисляется до первой строки тела модуля. Оба
 * вызова уходили в один тик вплотную — в собранном бандле буквально
 * `se("JS loaded, importing modules…");se("imports ok, mounting…");`. Значит
 * состояние «JS доехал, тянем модули» не показывалось никогда, и упавший
 * импорт (битый чанк после редеплоя, SyntaxError в старом WebView Telegram)
 * выглядел ровно как «модуль не доехал вовсе»: сплэш навсегда застывал на
 * «Загружаем интерфейс…» из index.html. Лестница, добавленная чтобы эти два
 * случая различать, их не различала.
 */

/** Покрасить сплэш текущей стадией загрузки. Узлы ставит index.html. */
export function debug(stage: string) {
  try {
    const el = document.getElementById("boot-err");
    if (el) {
      el.style.background = "#27ae60";
      el.textContent = "[boot] " + stage;
    }
    const lbl = document.getElementById("boot-label");
    if (lbl) lbl.textContent = stage;
  } catch {}
}

debug("JS loaded, importing modules…");
