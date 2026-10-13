import assert from 'node:assert/strict';
import test from 'node:test';

import { onRequest } from '../functions/api/[[path]].js';

const origin = 'https://worker.test';
const baseEnv = {
  AUTH_SECRET: 'worker-director-layout-test-secret',
  LOGIN_PASSWORD: 'test-password',
};

const call = (path, { method = 'GET', token = '', body, env = baseEnv } = {}) => onRequest({
  request: new Request(`${origin}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  }),
  env,
  context: {},
});

const login = async () => {
  const response = await call('/api/auth/login', {
    method: 'POST',
    body: { password: baseEnv.LOGIN_PASSWORD },
  });
  assert.equal(response.status, 200);
  return (await response.json()).token;
};

const validDraft = {
  scale: { mode: 'estimated', confidence: 0.8 },
  components: [{
    id: 'wall_01',
    name: '后墙',
    category: 'wall',
    primitive: 'box',
    position: [0, 0, -3],
    size: [6, 2.8, 0.15],
    rotationYDegrees: 0,
    confidence: 0.9,
    uncertain: false,
    notes: '',
  }],
};

test('director-layout route requires authentication', async () => {
  const response = await call('/api/director-layout', { method: 'POST', body: {} });
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: 'UNAUTHORIZED' });
});

test('director-layout rejects unsupported methods after authentication', async () => {
  const token = await login();
  const response = await call('/api/director-layout', { method: 'GET', token });
  assert.equal(response.status, 405);
  assert.deepEqual(await response.json(), { error: 'METHOD_NOT_ALLOWED' });
});

test('director-layout returns 501 when the vision model is not configured', async () => {
  const token = await login();
  const response = await call('/api/director-layout', {
    method: 'POST',
    token,
    body: { image: { url: 'data:image/png;base64,AA==' } },
  });
  assert.equal(response.status, 501);
  assert.deepEqual(await response.json(), { error: 'DIRECTOR_LAYOUT_MODEL_NOT_CONFIGURED' });
});

test('director-layout rejects an invalid image before calling the model', async () => {
  const token = await login();
  const response = await call('/api/director-layout', {
    method: 'POST',
    token,
    env: { ...baseEnv, DIRECTOR_LAYOUT_API_KEY: 'test-key' },
    body: { image: { url: 'file:///local/reference.png' } },
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'DIRECTOR_LAYOUT_IMAGE_REQUIRED' });
});

test('dedicated director-layout configuration does not activate text generation', async () => {
  const token = await login();
  const response = await call('/api/generate/text', {
    method: 'POST',
    token,
    env: { ...baseEnv, DIRECTOR_LAYOUT_API_KEY: 'test-key' },
    body: { prompt: 'keep text generation on its existing mock path' },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    text: 'keep text generation on its existing mock path',
    mock: true,
  });
});

test('director-layout returns a validated draft without a retry', async (t) => {
  const token = await login();
  let modelCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    modelCalls += 1;
    const payload = JSON.parse(init.body);
    assert.equal(url, 'https://director-layout.test/custom-layout');
    assert.equal(payload.model, 'director-layout-model');
    assert.equal(payload.messages[1].content[0].image_url.url, 'data:image/png;base64,AA==');
    return Response.json({
      choices: [{ message: { content: JSON.stringify(validDraft) } }],
      usage: { total_tokens: 42 },
    });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const response = await call('/api/director-layout', {
    method: 'POST',
    token,
    env: {
      ...baseEnv,
      DIRECTOR_LAYOUT_API_KEY: 'test-key',
      DIRECTOR_LAYOUT_BASE_URL: 'https://director-layout.test',
      DIRECTOR_LAYOUT_ENDPOINT: '/custom-layout',
      DIRECTOR_LAYOUT_MODEL_ID: 'director-layout-model',
      MIMO_API_KEY: 'fallback-key',
    },
    body: { image: { url: 'data:image/png;base64,AA==' } },
  });
  assert.equal(response.status, 200);
  assert.equal(modelCalls, 1);
  assert.deepEqual(await response.json(), { draft: validDraft, usage: { total_tokens: 42 } });
});

test('director-layout sends the spatial and uniform-scale contract to the configured model', async (t) => {
  const token = await login();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const payload = JSON.parse(init.body);
    const systemPrompt = payload.messages[0].content;
    assert.match(systemPrompt, /无人图：只根据可见建筑、家具和空间关系选择尺度锚点，不要虚构人物/);
    assert.match(systemPrompt, /人物、家具和空间共用同一把尺/);
    assert.match(systemPrompt, /整张图只能使用一次统一的比例尺/);
    assert.match(systemPrompt, /(?:不要|不能)把屏幕二维左右、上下或像素距离直接当作世界距离或米/);
    assert.match(systemPrompt, /床不是合法 category/);
    assert.match(systemPrompt, /只识别这些 category：ground, wall, door, window, table, chair, sofa, cabinet/);
    return Response.json({ choices: [{ message: { content: JSON.stringify(validDraft) } }] });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const response = await call('/api/director-layout', {
    method: 'POST',
    token,
    env: { ...baseEnv, DIRECTOR_LAYOUT_API_KEY: 'test-key' },
    body: { image: { url: 'https://example.com/empty-room.png' } },
  });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).draft, validDraft);
});

test('director-layout corrects invalid model JSON once and then succeeds', async (t) => {
  const token = await login();
  let modelCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    modelCalls += 1;
    const payload = JSON.parse(init.body);
    if (modelCalls === 1) {
      return Response.json({ choices: [{ message: { content: '{"components":[]}' } }] });
    }
    assert.match(payload.messages[1].content[1].text, /上一次输出未通过校验/);
    return Response.json({ choices: [{ message: { content: `\`\`\`json\n${JSON.stringify(validDraft)}\n\`\`\`` } }] });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const response = await call('/api/director-layout', {
    method: 'POST',
    token,
    env: { ...baseEnv, MIMO_API_KEY: 'fallback-key' },
    body: { image: { url: 'https://example.com/reference.png' } },
  });
  assert.equal(response.status, 200);
  assert.equal(modelCalls, 2);
  assert.deepEqual((await response.json()).draft, validDraft);
});

const draftWithCharacters = {
  ...validDraft,
  characters: [
    {
      id: 'char_01',
      name: '人物甲',
      position: [-0.6, 0.45, 0.2],
      height: 1.7,
      rotationYDegrees: 15,
      posture: 'sit',
      bodyTypeHint: 'male',
      confidence: 0.7,
      uncertain: false,
      notes: '坐在沙发左侧',
    },
    {
      id: 'char_02',
      name: '人物乙',
      position: [0.8, 0, 0.4],
      height: 1.62,
      rotationYDegrees: -90,
      posture: 'stand',
      bodyTypeHint: 'female',
      confidence: 0.6,
      uncertain: true,
    },
  ],
};

test('director-layout returns a draft with characters unchanged', async (t) => {
  const token = await login();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({
    choices: [{ message: { content: JSON.stringify(draftWithCharacters) } }],
  });
  t.after(() => { globalThis.fetch = originalFetch; });

  const response = await call('/api/director-layout', {
    method: 'POST',
    token,
    env: { ...baseEnv, DIRECTOR_LAYOUT_API_KEY: 'test-key' },
    body: { image: { url: 'https://example.com/sofa.png' } },
  });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.draft.characters.length, 2);
  assert.equal(data.draft.characters[0].posture, 'sit');
  // 坐姿人物的 Y 是座面高度，不能被当作地形高度抹平
  assert.equal(data.draft.characters[0].position[1], 0.45);
  assert.equal(data.draft.characters[1].posture, 'stand');
});

test('director-layout rejects an out-of-range character height and retries', async (t) => {
  const token = await login();
  let modelCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    modelCalls += 1;
    if (modelCalls === 1) {
      return Response.json({
        choices: [{
          message: {
            content: JSON.stringify({
              ...validDraft,
              // 人物被估成 6 米：等于把人拉到和整面墙一样大，必须拦下
              characters: [{ ...draftWithCharacters.characters[0], height: 6 }],
            }),
          },
        }],
      });
    }
    const payload = JSON.parse(init.body);
    assert.match(payload.messages[1].content[1].text, /身高必须是/);
    return Response.json({ choices: [{ message: { content: JSON.stringify(draftWithCharacters) } }] });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const response = await call('/api/director-layout', {
    method: 'POST',
    token,
    env: { ...baseEnv, DIRECTOR_LAYOUT_API_KEY: 'test-key' },
    body: { image: { url: 'https://example.com/sofa.png' } },
  });
  assert.equal(response.status, 200);
  assert.equal(modelCalls, 2);
  assert.deepEqual((await response.json()).draft, draftWithCharacters);
});

test('director-layout accepts a scene-only draft without a characters field', async (t) => {
  const token = await login();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({
    choices: [{ message: { content: JSON.stringify(validDraft) } }],
  });
  t.after(() => { globalThis.fetch = originalFetch; });

  const response = await call('/api/director-layout', {
    method: 'POST',
    token,
    env: { ...baseEnv, DIRECTOR_LAYOUT_API_KEY: 'test-key' },
    body: { image: { url: 'https://example.com/empty-room.png' } },
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).draft.characters, undefined);
});

test('director-layout stops after two invalid model responses', async (t) => {
  const token = await login();
  let modelCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    modelCalls += 1;
    return Response.json({ choices: [{ message: { content: '{"components":[]}' } }] });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const response = await call('/api/director-layout', {
    method: 'POST',
    token,
    env: { ...baseEnv, DIRECTOR_LAYOUT_API_KEY: 'test-key' },
    body: { image: { url: 'https://example.com/reference.png' } },
  });
  assert.equal(response.status, 502);
  assert.equal(modelCalls, 2);
  const data = await response.json();
  assert.equal(data.error, 'DIRECTOR_LAYOUT_INVALID_MODEL_JSON');
  assert.match(data.issues[0], /没有识别到可用的粗布景组件/);
});

test('director-layout preserves upstream quota status without retrying', async (t) => {
  const token = await login();
  t.mock.method(console, 'error', () => {});
  let modelCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    modelCalls += 1;
    return Response.json({ message: 'quota exhausted' }, { status: 402 });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const response = await call('/api/director-layout', {
    method: 'POST',
    token,
    env: { ...baseEnv, DIRECTOR_LAYOUT_API_KEY: 'test-key' },
    body: { image: { url: 'https://example.com/reference.png' } },
  });
  assert.equal(response.status, 402);
  assert.equal(modelCalls, 1);
  assert.deepEqual(await response.json(), { error: 'quota exhausted' });
});
