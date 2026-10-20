import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { Miniflare } from 'miniflare';
import { build } from 'esbuild';
import { MOCK_GLB } from './fixtures/image-to-3d-mock-provider.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
const mockProviderPath = path.join(root, 'tests/fixtures/image-to-3d-mock-provider.js');

async function makeWorker() {
  const bundled = await build({
    absWorkingDir: root,
    entryPoints: ['worker/index.js'],
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'esm',
    target: 'es2022',
    plugins: [{
      name: 'mock-image-to-3d-provider',
      setup(buildApi) {
        buildApi.onResolve({ filter: /imageTo3dProvider\.js$/ }, () => ({ path: mockProviderPath }));
      },
    }],
  });
  return new Miniflare({
    modules: true,
    script: bundled.outputFiles[0].text,
    compatibilityDate: '2026-05-28',
    durableObjects: { IMAGE_TO_3D_JOBS: { className: 'ImageTo3DJob', useSQLite: true } },
    kvNamespaces: ['IMAGE_TO_3D_ASSETS'],
    bindings: {
      IMAGE_TO_3D_ACCESS_KEY: 'local-test-operator-key',
      AUTH_SECRET: 'local-test-auth-secret',
      LOGIN_PASSWORD: 'local-test-password',
      HF_TOKEN: 'mock-only-provider-token',
    },
  });
}

async function createAuthorizedJob(mf, fileName = 'chair.png') {
  const login = await mf.dispatchFetch('https://local.test/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'local-test-password' }),
  });
  assert.equal(login.status, 200);
  const { token } = await login.json();
  const form = new FormData();
  form.append('image', new File([png], fileName, { type: 'image/png' }));
  const encodedForm = new Request('https://local.test/api/image-to-3d/jobs', { method: 'POST', body: form });
  const formContentType = encodedForm.headers.get('content-type');
  const formBytes = new Uint8Array(await encodedForm.arrayBuffer());
  const id = crypto.randomUUID();
  const jobCapability = crypto.randomUUID() + crypto.randomUUID();
  const assetCapability = crypto.randomUUID() + crypto.randomUUID();
  const response = await mf.dispatchFetch('https://local.test/api/image-to-3d/jobs', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': formContentType,
      'X-Image-To-3D-Access-Key': 'local-test-operator-key',
      'X-Image-To-3D-Job-Id': id,
      'X-Image-To-3D-Job-Capability': jobCapability,
      'X-Image-To-3D-Asset-Capability': assetCapability,
    },
    body: formBytes,
  });
  const job = await response.json();
  assert.equal(response.status, 202, JSON.stringify(job));
  return { token, id, jobCapability, assetCapability, job };
}

async function waitForJob(mf, job, expectedState, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await mf.dispatchFetch(`https://local.test/api/image-to-3d/jobs/${job.id}?cap=${job.jobCapability}`, {
      headers: { Authorization: `Bearer ${job.token}` },
    });
    assert.equal(response.status, 200);
    const state = await response.json();
    if (state.state === expectedState) return state;
    if (['failed', 'unknown', 'cancelled'].includes(state.state)) assert.fail(`job ended as ${state.state}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`job did not reach ${expectedState}`);
}

test('real Worker API + SQLite Durable Object alarm + KV persist one mock GLB through capability routes', async (t) => {
  const mf = await makeWorker();
  t.after(() => mf.dispose());

  const created = await createAuthorizedJob(mf);
  assert.equal(created.job.state, 'queued');
  const completed = await waitForJob(mf, created, 'completed');
  assert.equal(completed.glbBytes, MOCK_GLB.byteLength);

  const asset = await mf.dispatchFetch(`https://local.test${created.job.assetUrl}`);
  assert.equal(asset.status, 200);
  assert.equal(asset.headers.get('content-type'), 'model/gltf-binary');
  assert.equal(asset.headers.get('content-length'), String(MOCK_GLB.byteLength));
  assert.deepEqual(new Uint8Array(await asset.arrayBuffer()), MOCK_GLB);

  const wrongCapability = await mf.dispatchFetch(`https://local.test/api/image-to-3d/jobs/${created.id}?cap=${'0'.repeat(64)}`, {
    headers: { Authorization: `Bearer ${created.token}` },
  });
  assert.equal(wrongCapability.status, 404);
});

test('real Worker API cancels queued work but rejects cancellation after it starts', async (t) => {
  const mf = await makeWorker();
  t.after(() => mf.dispose());
  const created = await createAuthorizedJob(mf, 'queued.png');
  const cancel = await mf.dispatchFetch(`https://local.test/api/image-to-3d/jobs/${created.id}/cancel?cap=${created.jobCapability}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${created.token}` },
  });
  // Alarm timing is intentionally real; if it already started, cancellation must be rejected.
  assert.ok([200, 409].includes(cancel.status));
  const response = await mf.dispatchFetch(`https://local.test/api/image-to-3d/jobs/${created.id}?cap=${created.jobCapability}`, {
    headers: { Authorization: `Bearer ${created.token}` },
  });
  assert.equal(response.status, 200);
  const state = await response.json();
  if (cancel.status === 200) assert.equal(state.state, 'cancelled');
  else assert.ok(['running', 'submitting', 'processing', 'completed'].includes(state.state));
});

test('DO distinguishes a known provider rejection from an uncertain submitted task', async (t) => {
  const mf = await makeWorker();
  t.after(() => mf.dispose());
  const known = await createAuthorizedJob(mf, 'known-error.png');
  const failed = await waitForJob(mf, known, 'failed');
  assert.equal(failed.error, 'PROVIDER_QUOTA_EXHAUSTED');

  const uncertain = await createAuthorizedJob(mf, 'uncertain-error.png');
  const unknown = await waitForJob(mf, uncertain, 'unknown');
  assert.equal(unknown.error, 'SUBMISSION_STATUS_UNKNOWN');
});

test('DO records malformed or oversized provider results as failed, not unknown', async (t) => {
  const mf = await makeWorker();
  t.after(() => mf.dispose());
  const invalid = await createAuthorizedJob(mf, 'invalid-output.png');
  const failed = await waitForJob(mf, invalid, 'failed');
  assert.equal(failed.error, 'PROVIDER_RESULT_INVALID');
});

test('DO keeps the last provider phase on a definitive connect failure', async (t) => {
  const mf = await makeWorker();
  t.after(() => mf.dispose());
  const created = await createAuthorizedJob(mf, 'connect-error.png');
  const failed = await waitForJob(mf, created, 'failed');
  assert.equal(failed.phase, 'connecting');
  assert.equal(failed.error, 'PROVIDER_CONNECT_FAILED');
});
