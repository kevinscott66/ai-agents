// Разбирает stdout `bun audit --json` в плоские строки для сверки в bash.
//
// Формат bun: пустой объект `{}` — чисто, иначе
// {"<пакет>":[{id,url,title,severity,vulnerable_versions,cwe,cvss}, …]}.
// Всё, что не разбирается как такой объект (пустой вывод, текст ошибки,
// оборванный ответ реестра), — это НЕ «чисто»: выходим с 1, вызывающий скрипт
// превращает это в exit 2 «refusing to pass». Сюда же попадает JSON-массив или
// строка: формат вывода мог измениться, и тихо считать это отсутствием находок
// нельзя.
//
// На stdout: "<dir> <package> <id> <severity> <title>" по одной находке.

import { readFileSync } from "node:fs";

const dir = process.argv[2];
if (!dir) {
  process.stderr.write("usage: dependency-audit-flatten.mjs <dir> < audit.json\n");
  process.exit(2);
}

let raw;
try {
  raw = readFileSync(0, "utf8");
} catch {
  process.stderr.write("dependency-audit-flatten: не удалось прочитать stdin\n");
  process.exit(1);
}

let parsed;
try {
  parsed = JSON.parse(raw);
} catch {
  process.stderr.write("dependency-audit-flatten: stdin не является JSON\n");
  process.exit(1);
}

if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
  process.stderr.write("dependency-audit-flatten: ожидался объект вида {пакет: [находки]}\n");
  process.exit(1);
}

const lines = [];
for (const [pkg, advisories] of Object.entries(parsed)) {
  if (!Array.isArray(advisories)) {
    process.stderr.write(`dependency-audit-flatten: у пакета ${pkg} не массив находок\n`);
    process.exit(1);
  }
  for (const advisory of advisories) {
    const id = advisory && (advisory.id ?? advisory.url);
    if (id === undefined || id === null || id === "") {
      process.stderr.write(`dependency-audit-flatten: находка у ${pkg} без id\n`);
      process.exit(1);
    }
    const severity = (advisory.severity ?? "unknown").toString();
    // Заголовки бывают многострочными и очень длинными — в одну строку и с
    // обрезкой, иначе сверка по первым трём полям разъедется.
    const title = (advisory.title ?? "").toString().replace(/\s+/g, " ").slice(0, 120);
    lines.push(`${dir} ${pkg} ${id} ${severity} ${title}`);
  }
}

process.stdout.write(lines.length ? lines.join("\n") + "\n" : "");
