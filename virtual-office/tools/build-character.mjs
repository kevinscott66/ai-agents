/** One-time source conversion. Requires local dev server and ignored source-assets. */
import { chromium } from "@playwright/test";
import { writeFileSync } from "node:fs";
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage();
  await page.goto("http://127.0.0.1:4317/office/v1/capabilities");
  // A JSON document has no HMR client: dependency discovery cannot reload the conversion.
  const root = process.cwd();
  const result = await page.evaluate(
    async ({ root }) => {
      const { convert } = await import(
        "/@fs/" + root + "/tools/character-converter.ts"
      );
      return convert("/@fs/" + root + "/.runtime/source-assets/");
    },
    { root },
  );
  writeFileSync(
    "web/public/assets/characters/backend.glb",
    Buffer.from(result.base64, "base64"),
  );
  writeFileSync(
    ".runtime/character-conversion.json",
    JSON.stringify(result.summary, null, 2),
  );
  console.log(
    JSON.stringify(
      { bytes: result.summary.bytes, clips: result.summary.clips },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
