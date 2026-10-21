import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test('local Node director-layout route sends all selected images in one provider user message', async (t) => {
  const providerPayloads = [];
  const provider = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      providerPayloads.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ spaceType: 'open', surfaces: [], items: [] }) } }] }));
    });
  });
  await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
  const providerPort = provider.address().port;
  const apiPort = await freePort();
  const app = spawn(process.execPath, ['server/server.mjs'], {
    cwd: rootDir,
    env: {
      ...process.env,
      PORT: String(apiPort),
      AUTH_SECRET: 'multi-image-local-test-auth-secret',
      LOGIN_PASSWORD: 'multi-image-test-password',
      DIRECTOR_LAYOUT_API_KEY: 'test-layout-key',
      MIMO_BASE_URL: `http://127.0.0.1:${providerPort}`,
      MIMO_TEXT_ENDPOINT: '/chat/completions',
      MIMO_VISION_MODEL_ID: 'test-vision-model',
    },
    stdio: 'ignore',
  });
  t.after(async () => {
    app.kill();
    await new Promise((resolve) => provider.close(resolve));
  });

  const baseUrl = `http://127.0.0.1:${apiPort}`;
  let loginResponse;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (app.exitCode !== null) throw new Error(`local Node server exited (${app.exitCode})`);
    try {
      loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'multi-image-test-password' }),
      });
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  assert.equal(loginResponse?.status, 200, 'local Node server should start');
  const { token } = await loginResponse.json();
  const images = [
    { id: 'main', sourceId: 'main', role: 'primary', url: 'data:image/png;base64,AA==' },
    { id: 'side', sourceId: 'side', role: 'supplementary', url: 'data:image/jpeg;base64,AQ==' },
    { id: 'detail', sourceId: 'detail', role: 'supplementary', url: 'data:image/webp;base64,Ag==' },
  ];
  const response = await fetch(`${baseUrl}/api/director-layout`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ outputFormat: 'image-observations-v1', images }),
  });
  assert.equal(response.status, 200);
  const payload = providerPayloads[0];
  assert.equal(payload.messages.filter((message) => message.role === 'user').length, 1);
  assert.deepEqual(payload.messages[1].content.filter((part) => part.type === 'image_url').map((part) => part.image_url.url), images.map((image) => image.url));
});
