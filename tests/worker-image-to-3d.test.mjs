import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@gradio/client';
import { handleImageTo3dRequest, validateGlbBytes, validateImageBytes } from '../worker/imageTo3dJob.js';
import { downloadProviderGlb, findGlbFile, generateGlb, safeProviderError } from '../worker/imageTo3dProvider.js';

const PNG = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
const GLB = Uint8Array.from([0x67, 0x6c, 0x54, 0x46, 2, 0, 0, 0, 12, 0, 0, 0]);

test('default TRELLIS connection preserves the Gradio static Client receiver and classifies connect failures', async () => {
  const originalConnect = Client.connect;
  let receiver;
  let receivedSpace;
  let receivedOptions;
  Client.connect = function (space, options) {
    receiver = this;
    receivedSpace = space;
    receivedOptions = options;
    throw new TypeError('synthetic non-provider connection stop');
  };
  try {
    await assert.rejects(
      () => generateGlb({ token: 'test-token', bytes: PNG, fileName: 'object.png', mimeType: 'image/png' }),
      (error) => error.providerPhase === 'connecting' && safeProviderError(error) === 'PROVIDER_CONNECT_FAILED',
    );
  } finally {
    Client.connect = originalConnect;
  }
  assert.equal(receiver, Client);
  assert.equal(receivedSpace, 'trellis-community/TRELLIS');
  assert.deepEqual(receivedOptions, { token: 'test-token', events: ['status', 'data'] });
});

test('image and GLB validation checks MIME magic, GLB version, and hard size limits', () => {
  assert.equal(validateImageBytes(PNG, 'image/png'), true);
  assert.equal(validateImageBytes(PNG, 'image/jpeg'), false);
  assert.equal(validateImageBytes(new Uint8Array(0), 'image/png'), false);
  assert.equal(validateGlbBytes(GLB), true);
  assert.equal(validateGlbBytes(Uint8Array.from([0x67, 0x6c, 0x54, 0x46, 1, 0, 0, 0, 12, 0, 0, 0])), false);
  assert.equal(validateGlbBytes(new Uint8Array(20 * 1024 * 1024 + 1)), false);
});

test('TRELLIS adapter follows official preprocess, start-session, and frozen single-image parameters', async () => {
  const calls = [];
  const events = [];
  const client = {
    session_hash: 'mock-session',
    config: { root: 'https://trellis-community-trellis.hf.space' },
    close() { calls.push('close'); },
    async predict(endpoint, data) {
      calls.push(`predict:${endpoint}`);
      assert.equal(data.image instanceof File, true);
      return { type: 'data', data: [{ path: '/file=processed.png', url: '/file=processed.png', mime_type: 'image/png' }] };
    },
    submit(endpoint, data) {
      calls.push(`submit:${endpoint}`);
      if (endpoint === '/start_session') {
        return (async function* () { yield { type: 'status', stage: 'complete', success: true }; })();
      }
      events.push(data);
      return {
        async wait_for_id() { return 'provider-event-1'; },
        async *[Symbol.asyncIterator]() {
          yield { type: 'status', stage: 'complete', success: true };
          yield { type: 'data', data: [{ path: '/file=preview.mp4' }, { path: '/file=sample.glb', url: '/file=sample.glb' }] };
        },
      };
    },
    async fetch(url) {
      const path = new URL(url).pathname;
      if (path.endsWith('processed.png')) return new Response(PNG, { headers: { 'content-length': String(PNG.length) } });
      if (path.endsWith('sample.glb')) return new Response(GLB, { headers: { 'content-length': String(GLB.length) } });
      throw new Error(`unexpected mocked provider path: ${path}`);
    },
  };
  const connected = [];
  const progress = [];
  const result = await generateGlb({
    token: 'mock-token',
    bytes: PNG,
    fileName: 'object.png',
    mimeType: 'image/png',
    connect: async (space, options) => {
      calls.push(`connect:${space}`);
      assert.equal(options.token, 'mock-token');
      return client;
    },
    onConnected: () => connected.push('connected'),
    onPhase: (phase) => progress.push(phase),
    onSubmitStarting: () => calls.push('submit-starting-persisted'),
    onSubmitted: (value) => calls.push(`event-persisted:${value.eventId}:${value.sessionHash}`),
    onProgress: (value) => progress.push(value.stage),
  });
  assert.equal(connected.length, 1);
  assert.deepEqual(calls.slice(0, 3), [
    'connect:trellis-community/TRELLIS',
    'submit:/start_session',
    'predict:/preprocess_image',
  ]);
  assert.ok(calls.indexOf('submit-starting-persisted') < calls.indexOf('submit:/generate_and_extract_glb'));
  assert.ok(calls.indexOf('event-persisted:provider-event-1:mock-session') > calls.indexOf('submit:/generate_and_extract_glb'));
  assert.deepEqual(progress, ['starting-session', 'preprocessing', 'submitting', 'complete']);
  assert.equal(findGlbFile(result.file)?.path, '/file=sample.glb');
  assert.equal(validateGlbBytes(await downloadProviderGlb(result.client, result.file, 20 * 1024 * 1024)), true);
  assert.deepEqual(Object.keys(events[0]).sort(), [
    'image', 'mesh_simplify', 'multiimage_algo', 'multiimages', 'seed', 'slat_guidance_strength', 'slat_sampling_steps',
    'ss_guidance_strength', 'ss_sampling_steps', 'texture_size',
  ].sort());
  assert.equal(events[0].multiimages.length, 0);
  assert.equal(events[0].seed, 0);
  assert.equal(events[0].ss_guidance_strength, 7.5);
  assert.equal(events[0].ss_sampling_steps, 12);
  assert.equal(events[0].slat_guidance_strength, 3);
  assert.equal(events[0].slat_sampling_steps, 12);
  assert.equal(events[0].multiimage_algo, 'stochastic');
  assert.equal(events[0].mesh_simplify, 0.95);
  assert.equal(events[0].texture_size, 1024);
  result.client.close();
  assert.equal(calls.at(-1), 'close');
});

test('provider output download rejects URLs outside the connected Space origin', async () => {
  const client = { config: { root: 'https://trellis-community-trellis.hf.space' }, fetch: async () => new Response(GLB) };
  await assert.rejects(() => downloadProviderGlb(client, { url: 'https://attacker.invalid/sample.glb' }, 1024), /PROVIDER_RESULT_INVALID/);
});

test('provider output download refuses redirects before following another host', async () => {
  let redirectMode;
  const client = {
    config: { root: 'https://trellis-community-trellis.hf.space' },
    async fetch(_url, init) {
      redirectMode = init.redirect;
      return new Response(null, { status: 302, headers: { location: 'https://attacker.invalid/model.glb' } });
    },
  };
  await assert.rejects(() => downloadProviderGlb(client, { path: '/file=model.glb' }, 1024), /PROVIDER_RESULT_INVALID/);
  assert.equal(redirectMode, 'manual');
});

test('operator access code and bearer gate are enforced before accepting an image job', async () => {
  let forwarded = false;
  const namespace = {
    idFromName(name) { assert.equal(name, 'personal-image-to-3d'); return name; },
    get() {
      return { async fetch(request) { forwarded = true; assert.equal(request.method, 'POST'); return Response.json({ state: 'queued' }, { status: 202 }); } };
    },
  };
  const env = {
    IMAGE_TO_3D_JOBS: namespace,
    IMAGE_TO_3D_ASSETS: {},
    IMAGE_TO_3D_ACCESS_KEY: 'expected-access-code',
  };
  const request = new Request('https://example.test/api/image-to-3d/jobs', { method: 'POST' });
  const deniedBearer = await handleImageTo3dRequest({ request, env }, async () => false);
  assert.equal(deniedBearer.status, 401);
  assert.equal(forwarded, false);

  const form = new FormData();
  form.append('image', new File([PNG], 'chair.png', { type: 'image/png' }));
  const createRequest = new Request('https://example.test/api/image-to-3d/jobs', {
    method: 'POST',
    headers: {
      'X-Image-To-3D-Access-Key': 'wrong',
      'X-Image-To-3D-Job-Id': '00000000-0000-4000-8000-000000000001',
      'X-Image-To-3D-Job-Capability': 'a'.repeat(43),
      'X-Image-To-3D-Asset-Capability': 'b'.repeat(43),
    },
    body: form,
  });
  const deniedOperator = await handleImageTo3dRequest({ request: createRequest, env }, async () => true);
  assert.equal(deniedOperator.status, 403);
  assert.equal(forwarded, false);
});

test('provider error mapping never returns raw provider messages', () => {
  assert.equal(safeProviderError({ status: 429, message: 'private endpoint and token-bearing url' }), 'PROVIDER_CAPACITY_LIMIT');
  assert.equal(safeProviderError(new Error('signed url and secret')), 'PROVIDER_FAILED');
  assert.equal(safeProviderError(Object.assign(new Error('PROVIDER_RESULT_TOO_LARGE'), { definitive: true })), 'PROVIDER_RESULT_TOO_LARGE');
});

test('provider distinguishes explicit failure from uncertain submission interruption', async () => {
  const makeClient = (submission) => ({
    config: { root: 'https://trellis-community-trellis.hf.space' },
    session_hash: 'mock-session',
    submit: (endpoint) => endpoint === '/start_session' ? (async function* () {})() : submission,
    predict: async () => ({ data: [{ path: '/file=processed.png' }] }),
    fetch: async () => new Response(new Uint8Array([1, 2, 3])),
    close() {},
  });
  const input = { token: 'mock', bytes: new Uint8Array([1]), fileName: 'x.png', mimeType: 'image/png' };
  const statusFailure = async (event) => {
    const submission = {
      wait_for_id: async () => 'known-event',
      async *[Symbol.asyncIterator]() { yield { type: 'status', stage: 'error', ...event }; },
    };
    try {
      await generateGlb({ ...input, connect: async () => makeClient(submission) });
    } catch (error) {
      return error;
    }
    assert.fail('provider status error should reject generation');
  };
  const functionFailure = await statusFailure({ message: 'ValueError: private server path' });
  assert.equal(functionFailure.definitive, true);
  assert.equal(safeProviderError(functionFailure), 'PROVIDER_JOB_FAILED');
  assert.doesNotMatch(safeProviderError(functionFailure), /private server path/);

  const quotaFailure = await statusFailure({ message: 'GPU quota exhausted for this account' });
  assert.equal(quotaFailure.definitive, true);
  assert.equal(safeProviderError(quotaFailure), 'PROVIDER_QUOTA_EXHAUSTED');

  const authFailure = await statusFailure({ message: '401 Unauthorized: token rejected' });
  assert.equal(authFailure.definitive, true);
  assert.equal(safeProviderError(authFailure), 'PROVIDER_AUTH_FAILED');

  const brokenConnection = await statusFailure({ broken: true, message: 'signed URL disconnected' });
  assert.equal(brokenConnection.definitive, undefined);
  assert.equal(brokenConnection.submissionUncertain, true);
  assert.equal(safeProviderError(brokenConnection), 'PROVIDER_SUBMISSION_UNCONFIRMED');

  const connectionError = await statusFailure({ code: 'connection_error', message: 'private socket details' });
  assert.equal(connectionError.submissionUncertain, true);
  assert.doesNotMatch(safeProviderError(connectionError), /private socket details/);

  const uncertainFailure = {
    wait_for_id: async () => { throw new Error('connection dropped'); },
    async *[Symbol.asyncIterator]() {},
  };
  await assert.rejects(
    () => generateGlb({ ...input, connect: async () => makeClient(uncertainFailure) }),
    (error) => error.submissionUncertain === true,
  );
});

test('late CPU preprocessing cannot submit after its task becomes terminal', async () => {
  let releasePreprocess;
  let generationSubmits = 0;
  const preprocessed = new Promise((resolve) => { releasePreprocess = resolve; });
  const client = {
    config: { root: 'https://trellis-community-trellis.hf.space' },
    submit(endpoint) {
      if (endpoint === '/start_session') return (async function* () {})();
      generationSubmits += 1;
      throw new Error('generation should not be submitted');
    },
    predict: async () => { await preprocessed; return { data: [{ path: '/file=processed.png' }] }; },
    fetch: async () => new Response(new Uint8Array([1, 2, 3])),
    close() {},
  };
  const run = generateGlb({
    token: 'mock', bytes: new Uint8Array([1]), fileName: 'late.png', mimeType: 'image/png',
    connect: async () => client,
    onSubmitStarting: () => false,
  });
  releasePreprocess();
  await assert.rejects(run, /JOB_NO_LONGER_ACTIVE/);
  assert.equal(generationSubmits, 0);
});

test('a terminal task rejects a late provider event persistence callback', async () => {
  let consumedEvents = false;
  const client = {
    config: { root: 'https://trellis-community-trellis.hf.space' },
    session_hash: 'mock-session',
    submit: (endpoint) => endpoint === '/start_session'
      ? (async function* () {})()
      : ({
        wait_for_id: async () => 'late-event',
        async *[Symbol.asyncIterator]() { consumedEvents = true; yield { type: 'data', data: [] }; },
      }),
    predict: async () => ({ data: [{ path: '/file=processed.png' }] }),
    fetch: async () => new Response(new Uint8Array([1, 2, 3])),
    close() {},
  };
  await assert.rejects(() => generateGlb({
    token: 'mock', bytes: new Uint8Array([1]), fileName: 'late.png', mimeType: 'image/png',
    connect: async () => client,
    onSubmitted: () => false,
  }), /JOB_NO_LONGER_ACTIVE/);
  assert.equal(consumedEvents, false);
});
