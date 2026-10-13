import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const artifactDir = dirname(fileURLToPath(import.meta.url));
const response = JSON.parse(await readFile(join(artifactDir, "current-prompt-response.json"), "utf8"));
const referencePath = join(artifactDir, "reference-temple.png");
const appUrl = process.env.DIRECTOR_DESK_URL ?? "http://127.0.0.1:4174/director-desk/index.html";
let apiFixtureCalls = 0;
const consoleErrors = [];

const browser = await chromium.launch({
  headless: true,
  executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
});
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
page.setDefaultTimeout(12_000);
page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text());
});
page.on("pageerror", (error) => consoleErrors.push(error.message));
await page.route("**/api/director-layout", async (route) => {
  apiFixtureCalls += 1;
  await route.fulfill({
    status: 200,
    contentType: "application/json; charset=utf-8",
    body: JSON.stringify(response),
  });
});

await page.goto(appUrl, { waitUntil: "networkidle" });
if (await page.getByLabel("上传粗布景参考图").count() === 0) {
  await page.getByRole("button", { name: /导演台 1 号/ }).first().click();
}
await page.getByLabel("上传粗布景参考图").setInputFiles(referencePath);
await page.getByRole("button", { name: "生成粗布景" }).click();
await page.getByText(/待应用布景 · 19 个组件 \/ 1 个人物/).waitFor();
await page.getByRole("button", { name: /礼佛女子/ }).click();

const facing = page.getByLabel("面朝（度）");
const originalYaw = await facing.inputValue();
await page.screenshot({ path: join(artifactDir, "02-real-response-seiza-prayer-warning.png") });
await facing.fill("90");
await facing.press("Enter");
await page.waitForTimeout(1200);

const inspectionYaw = await facing.inputValue();
const kneelVariant = await page.getByLabel("跪姿细分").inputValue();
const handGesture = await page.getByLabel("手势").inputValue();
await page.screenshot({ path: join(artifactDir, "05-seiza-side-pose-check.png") });

await page.locator(".reference-layout-component-row", { hasText: "坐垫" }).first().click();
const propAnchorBlank = await page.getByLabel("已知高度（米）").inputValue() === ""
  && await page.getByRole("button", { name: "校正" }).isDisabled();
await page.locator(".reference-layout-component-row", { hasText: "左侧立柱" }).click();
const pillarAnchorBlank = await page.getByLabel("已知高度（米）").inputValue() === ""
  && await page.getByRole("button", { name: "校正" }).isDisabled();
await page.locator(".reference-layout-component-row", { hasText: "后墙" }).click();
const legacyWallAnchorPreserved = await page.getByLabel("已知高度（米）").inputValue() === "2.8";

const result = {
  purpose: "Temporary side-angle visual inspection only; yaw 90 is not the raw model pose.",
  appUrl,
  apiFixtureCalls,
  originalYaw: Number(originalYaw),
  inspectionYaw: Number(inspectionYaw),
  kneelVariant,
  handGesture,
  propAnchorBlank,
  pillarAnchorBlank,
  legacyWallAnchorPreserved,
  consoleErrors,
};
await writeFile(join(artifactDir, "seiza-side-check.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
await browser.close();

if (apiFixtureCalls !== 1 || originalYaw !== "180" || kneelVariant !== "seiza" || handGesture !== "prayer"
  || !propAnchorBlank || !pillarAnchorBlank || !legacyWallAnchorPreserved || consoleErrors.length) {
  console.error(JSON.stringify(result, null, 2));
  process.exit(1);
}
console.log(JSON.stringify(result, null, 2));
