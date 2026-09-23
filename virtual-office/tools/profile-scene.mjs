/** Bounded developer probe, not a GPU benchmark or a target-hardware guarantee. */
import { chromium } from "@playwright/test";
import { writeFileSync } from "node:fs";
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("http://127.0.0.1:4317");
  await page.getByText("Gateway подключён").waitFor();
  await page.getByRole("button", { name: "Пишет код", exact: true }).click();
  const report = {
    browser: browser.version(),
    viewport: "1440x1000",
    modes: {},
    errors,
  };
  for (const mode of ["balanced", "low"]) {
    await page.getByLabel("Качество отображения").selectOption(mode);
    await page.waitForTimeout(2500);
    report.modes[mode] = await page.evaluate(async () => {
      const canvas = document.querySelector("canvas");
      const start = performance.now(),
        first = +canvas.dataset.renderFrames,
        samples = [];
      for (let i = 0; i < 80; i++) {
        await new Promise((r) => setTimeout(r, 75));
        samples.push(+canvas.dataset.renderMs);
      }
      samples.sort((a, b) => a - b);
      return {
        durationMs: performance.now() - start,
        renderedFrames: +canvas.dataset.renderFrames - first,
        cpuSubmissionMsP95: samples[75],
        drawCalls: +canvas.dataset.drawCalls,
        triangles: +canvas.dataset.triangles,
        resolution: [canvas.width, canvas.height],
      };
    });
  }
  if (report.modes.low.resolution[0] !== 1080)
    throw new Error("Economy DPR did not reduce the render resolution");
  await page.getByLabel("Качество отображения").selectOption("2d");
  if (await page.locator("canvas").count())
    throw new Error("2D did not unmount WebGL");
  await page.getByLabel("Качество отображения").selectOption("balanced");
  await page.waitForTimeout(1500);
  await page.screenshot({ path: ".runtime/office-realistic.png" });
  await page.locator(".agent-summary").click();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: ".runtime/office-character-closeup.png" });
  writeFileSync(".runtime/scene-profile.json", JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (errors.length) process.exitCode = 1;
} finally {
  await browser.close();
}
