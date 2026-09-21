import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

const outDir = path.resolve('docs/director-desk-prd/screenshots');
const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const baseUrl = process.env.PRDTOOL_URL || 'http://127.0.0.1:3001/';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function safeClick(locator, timeout = 1500) {
  try {
    await locator.first().click({ timeout });
    return true;
  } catch {
    return false;
  }
}

async function shot(page, name, target = page) {
  await wait(350);
  const file = path.join(outDir, `${name}.png`);
  await target.screenshot({ path: file, animations: 'disabled' });
  const stat = await fs.stat(file);
  console.log(`${name}.png ${stat.size}`);
}

async function openCanvas(page) {
  await page.route('**/api/auth/me', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ user: { id: 'codex-prd', name: 'Codex PRD' } }),
    });
  });
  await page.addInitScript(() => {
    localStorage.setItem('KC_CANVAS_AUTH_TOKEN', 'codex-prd-token');
    localStorage.setItem('kc-canvas-welcome-seen', '1');
  });
  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  await safeClick(page.getByText('开始试用'));
  if (await page.getByText('KC 无限画布项目管理').isVisible({ timeout: 1500 }).catch(() => false)) {
    const project = page.getByText('《隐秘回响》').first();
    if (await project.isVisible({ timeout: 1500 }).catch(() => false)) {
      await project.click();
      await wait(1800);
    }
  }
  await safeClick(page.getByText('开始试用'), 3000);
  await wait(1000);
}

async function createDirectorNode(page) {
  const canvas = page.locator('.react-flow, [data-testid="rf__wrapper"], body').first();
  await canvas.click({ position: { x: 620, y: 420 } }).catch(() => {});
  await page.mouse.click(620, 420, { button: 'right' });
  await wait(500);
  await shot(page, '01-canvas-context-menu');
  const clicked = await safeClick(page.getByText('3D导演台'));
  if (!clicked) {
    throw new Error('未找到右键菜单里的 3D导演台');
  }
  await wait(1200);
  await shot(page, '02-director-node');
  if (!(await safeClick(page.getByText('进入'), 3000))) {
    await page.locator('text=打开导演台').first().click({ timeout: 5000 });
  }
  await wait(2200);
}

async function getDeskFrame(page) {
  const frameLocator = page.frameLocator('iframe[src*="director-desk"]');
  await frameLocator.locator('body').waitFor({ timeout: 20000 });
  return frameLocator;
}

function getDeskFrameObject(page) {
  const frame = page.frames().find((item) => item.url().includes('/director-desk/'));
  if (!frame) throw new Error('未找到导演台 iframe');
  return frame;
}

async function captureDesk(page) {
  const desk = await getDeskFrame(page);
  await shot(page, '03-director-space-full');

  await safeClick(desk.getByText('场景'));
  await shot(page, '04-scene-panel');

  await safeClick(desk.locator('button[aria-label="添加角色"]'));
  await shot(page, '05-add-character-menu');
  await page.keyboard.press('Escape').catch(() => {});

  await safeClick(desk.locator('button[aria-label="模型库"]'));
  await shot(page, '06-model-library');
  await page.mouse.click(943, 566).catch(() => {});
  await wait(500);

  await page.mouse.click(64, 255).catch(() => {});
  await wait(500);
  await shot(page, '07-character-properties');

  await safeClick(desk.getByText('姿势'));
  await shot(page, '08-pose-panel');

  await page.mouse.click(64, 344).catch(() => {});
  await wait(500);
  await shot(page, '09-camera-panel');

  await safeClick(desk.getByText('摄像机截图'));
  await safeClick(desk.getByText('当前机位截图'));
  await wait(1200);
  await shot(page, '10-camera-screenshot-list');

  const frame = getDeskFrameObject(page);
  await frame.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 1280;
    canvas.height = 720;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const gradient = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
    gradient.addColorStop(0, '#07111f');
    gradient.addColorStop(1, '#101828');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = '#1f6feb';
    for (let y = 430; y < 720; y += 42) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(1280, y);
      ctx.stroke();
    }
    ctx.fillStyle = '#2f80ed';
    ctx.beginPath();
    ctx.arc(640, 320, 70, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 44px Arial';
    ctx.textAlign = 'center';
    ctx.fillText('导演台截图', 640, 560);
    const dataUrl = canvas.toDataURL('image/png');
    window.parent?.postMessage(
      {
        type: 'storyai:director-desk-captures-sent',
        payload: { captures: [{ dataUrl, fileName: '导演台截图.png' }] },
      },
      window.location.origin
    );
    window.parent?.postMessage({ type: 'storyai:director-desk-close' }, window.location.origin);
  });
  await wait(1800);
  await shot(page, '11-return-image-node');
}

const browser = await chromium.launch({
  headless: true,
  executablePath: chromePath,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
await fs.mkdir(outDir, { recursive: true });
try {
  await openCanvas(page);
  await createDirectorNode(page);
  await captureDesk(page);
} finally {
  await browser.close();
}
