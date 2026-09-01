/** PUBLISH_TO_CHANNEL must stay behind its dedicated dispatch boundary. */
import { describe, test, expect } from "bun:test";

describe("PUBLISH_TO_CHANNEL dispatch boundary", () => {
  test("action-dispatch delegates delivery to the publish module", async () => {
    const dispatchSource = await Bun.file(
      new URL("../lib/action-dispatch.ts", import.meta.url),
    ).text();
    const publishSource = await Bun.file(
      new URL("../lib/dispatch/publish.ts", import.meta.url),
    ).text();
    const start = dispatchSource.indexOf('case "PUBLISH_TO_CHANNEL"');
    const end = dispatchSource.indexOf('case "GENERATE_SVG_IMAGE"');
    const actionSlice = dispatchSource.slice(start, end);

    expect(dispatchSource).toContain('from "./dispatch/publish.ts"');
    expect(actionSlice).toContain("handlePublishToChannel");
    expect(actionSlice).not.toContain("tgSendMessage");
    expect(actionSlice).not.toContain("ingestDigestToSite");
    expect(publishSource).toContain("isTeamChannel");
    expect(publishSource).toContain("guardedUserbotCall");
  });

  test("legacy fitToLimit export remains available from action-dispatch", async () => {
    const dispatchSource = await Bun.file(
      new URL("../lib/action-dispatch.ts", import.meta.url),
    ).text();
    expect(dispatchSource).toContain("export { fitToLimit }");
  });
});
