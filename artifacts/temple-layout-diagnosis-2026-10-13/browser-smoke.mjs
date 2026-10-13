import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const artifactDir = dirname(fileURLToPath(import.meta.url));
const response = JSON.parse(await readFile(join(artifactDir, "current-prompt-response.json"), "utf8"));
const referencePath = join(artifactDir, "reference-temple.png");
const results = { apiFixtureCalls: 0, checks: {}, consoleErrors: [] };
const browser = await chromium.launch({
  headless: true,
  executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
});
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });

page.on("console", (message) => {
  if (message.type() === "error") results.consoleErrors.push(message.text());
});
page.on("pageerror", (error) => results.consoleErrors.push(error.message));
await page.route("**/api/director-layout", async (route) => {
  results.apiFixtureCalls += 1;
  await route.fulfill({ status: 200, contentType: "application/json; charset=utf-8", body: JSON.stringify(response) });
});

await page.goto("http://127.0.0.1:4174/director-desk/index.html", { waitUntil: "networkidle" });
if (await page.getByLabel("上传粗布景参考图").count() === 0) {
  await page.getByRole("button", { name: /导演台 1 号/ }).first().click();
}
await page.getByLabel("上传粗布景参考图").setInputFiles(referencePath);
const thumbnail = page.getByRole("button", { name: /查看参考图大图/ });
await thumbnail.waitFor();

await thumbnail.focus();
await page.keyboard.press("Enter");
const dialog = page.getByRole("dialog", { name: /参考图查看器/ });
await dialog.waitFor();
const dialogBox = await dialog.boundingBox();
const imageBox = await page.getByAltText(/大图$/).boundingBox();
results.checks.enterOpensViewer = await dialog.isVisible();
results.checks.viewerCoversViewport = Boolean(dialogBox && dialogBox.width >= 1590 && dialogBox.height >= 990);
results.checks.imageInsideViewport = Boolean(imageBox && imageBox.x >= 0 && imageBox.y >= 0
  && imageBox.x + imageBox.width <= 1600 && imageBox.y + imageBox.height <= 1000);
await page.screenshot({ path: join(artifactDir, "01-reference-lightbox.png") });

await page.keyboard.press("Tab");
results.checks.tabTrappedOnClose = await page.getByLabel("关闭参考图查看器").evaluate((node) => document.activeElement === node);
await page.keyboard.press("Escape");
await dialog.waitFor({ state: "hidden" });
results.checks.escapeClosesAndReturnsFocus = await thumbnail.evaluate((node) => document.activeElement === node);

await thumbnail.click();
await page.getByLabel("关闭参考图查看器").click();
results.checks.closeButtonWorks = await dialog.isHidden();
await thumbnail.click();
await dialog.click({ position: { x: 8, y: 8 } });
results.checks.backdropCloses = await dialog.isHidden();

await thumbnail.click();
await page.evaluate(() => {
  window.dispatchEvent(new CustomEvent("storyai:director-desk-reference-images-updated", {
    detail: {
      images: [{
        edgeId: "fixture-edge",
        sourceNodeId: "fixture-second-source",
        imageUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+3MxZ5wAAAABJRU5ErkJggg==",
        fileName: "second-source.png",
      }],
    },
  }));
});
await page.getByLabel("选择粗布景参考图").selectOption("fixture-second-source", { force: true });
await dialog.waitFor({ state: "hidden" });
results.checks.sourceSwitchClosesViewer = true;
await page.getByLabel("选择粗布景参考图").selectOption({ label: "reference-temple.png" });

await thumbnail.click();
await page.evaluate(() => {
  window.dispatchEvent(new CustomEvent("storyai:director-desk-session-opened", { detail: { instanceId: "new-scope" } }));
});
await dialog.waitFor({ state: "hidden" });
results.checks.scopeSwitchClosesViewer = true;
await page.getByLabel("上传粗布景参考图").setInputFiles(referencePath);
await thumbnail.waitFor();

await page.getByRole("button", { name: "生成粗布景" }).click();
await page.getByText(/待应用布景 · 19 个组件 \/ 1 个人物/).waitFor();
results.checks.realResponseRendered = results.apiFixtureCalls === 1;
await page.getByRole("button", { name: /礼佛女子/ }).click();
const characterDiagnostic = page.getByText(/人物 Y=0\.12 与近邻组件 prop_cushion_01 顶面 Y=0\.18 不一致/);
await characterDiagnostic.waitFor();
results.checks.characterSupportMismatchVisible = await characterDiagnostic.isVisible();
results.checks.seizaVisible = await page.getByLabel("跪姿细分").evaluate((node) => node.value === "seiza");
results.checks.prayerVisible = await page.getByLabel("手势").evaluate((node) => node.value === "prayer");
await page.waitForTimeout(900);
await page.screenshot({ path: join(artifactDir, "02-real-response-seiza-prayer-warning.png") });

await page.getByRole("button", { name: /后墙/ }).click();
const wallDiagnostic = page.getByText(/可能是合法悬空墙段\/台上柱，也可能误用了几何中心 Y/);
await wallDiagnostic.waitFor();
results.checks.wallCenterYWarningVisible = await wallDiagnostic.isVisible();
await page.getByLabel("位置 Y").focus();
await page.keyboard.press("Delete");
results.checks.deleteInInputKeepsLayout = await page.getByText(/待应用布景 · 19 个组件 \/ 1 个人物/).isVisible();
await page.screenshot({ path: join(artifactDir, "03-real-response-wall-warning.png") });

await page.getByRole("button", { name: "添加到当前场景" }).click();
await page.waitForTimeout(500);
results.checks.applySucceeds = await page.getByText("礼佛女子", { exact: true }).count() > 0;
await page.waitForTimeout(900);
await page.screenshot({ path: join(artifactDir, "04-applied-real-response.png") });

await writeFile(join(artifactDir, "browser-result.json"), `${JSON.stringify(results, null, 2)}\n`, "utf8");
await browser.close();

if (results.consoleErrors.length || Object.values(results.checks).some((value) => value !== true)) {
  console.error(JSON.stringify(results, null, 2));
  process.exit(1);
}
console.log(JSON.stringify(results, null, 2));
