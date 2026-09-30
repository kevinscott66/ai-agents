import { chromium } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
const roster = JSON.parse(readFileSync("assets/roster-sources.json", "utf8"));
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage();
  await page.goto("http://127.0.0.1:4317/office/v1/capabilities");
  for (const entry of roster) {
    const result = await page.evaluate(
      async ({ root, entry }) => {
        const { convert } = await import(
          "/@fs/" + root + "/tools/character-converter.ts"
        );
        const base = "/@fs/" + root + "/.runtime/source-assets/";
        return convert(
          base + entry.source + "/",
          base + (entry.source.startsWith("Female") ? "female-motion/" : ""),
          512,
        );
      },
      { root: process.cwd(), entry },
    );
    writeFileSync(
      "web/public/assets/characters/" + entry.id + ".glb",
      Buffer.from(result.base64, "base64"),
    );
    writeFileSync(
      ".runtime/" + entry.id + "-conversion.json",
      JSON.stringify(result.summary, null, 2),
    );
    console.log(entry.id, result.summary.bytes);
  }
} finally {
  await browser.close();
}
