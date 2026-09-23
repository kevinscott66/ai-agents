import { chromium } from "@playwright/test";
import { writeFileSync } from "node:fs";
const variants = [
  ["Business_Male_01", "suit", ""],
  ["Business_Male_06", "shirt", ""],
  ["Business_Female_02", "bob", "female-motion/"],
  ["Business_Female_03", "skirt", "female-motion/"],
];
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage();
  await page.goto("http://127.0.0.1:4317/office/v1/capabilities");
  for (const [source, id, motion] of variants) {
    const result = await page.evaluate(
      async ({ root, source, motion }) => {
        const { convert } = await import(
          "/@fs/" + root + "/tools/character-converter.ts"
        );
        const base = "/@fs/" + root + "/.runtime/source-assets/";
        return convert(base + source + "/", base + motion);
      },
      { root: process.cwd(), source, motion },
    );
    writeFileSync(
      "web/public/assets/characters/" + id + ".glb",
      Buffer.from(result.base64, "base64"),
    );
    writeFileSync(
      ".runtime/" + id + "-conversion.json",
      JSON.stringify(result.summary, null, 2),
    );
    console.log(id, result.summary.bytes);
  }
} finally {
  await browser.close();
}
