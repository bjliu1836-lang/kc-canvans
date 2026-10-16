import assert from 'node:assert/strict';
import test from 'node:test';

import { onRequest } from '../functions/api/[[path]].js';
import { DIRECTOR_LAYOUT_OBSERVATION_FORMAT, parseDirectorLayoutObservation, summarizeDirectorLayoutObservationOutput } from '../functions/shared/director-layout-observations.js';

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
  characters: [],
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

const layoutEnv = { ...baseEnv, DIRECTOR_LAYOUT_API_KEY: 'test-key' };

test('director-layout observation mode uses one model call and returns only bounded visual observations', async (t) => {
  const token = await login();
  const observation = {
    spaceType: 'open',
    surfaces: [{ id: 'wall', kind: 'wall', side: 'image_back', bbox: [0, 0.1, 1, 0.8], confidence: 0.9 }],
    items: [{ id: 'desk', name: '桌子', semanticType: 'desk', bbox: [0.2, 0.4, 0.6, 0.7], confidence: 0.8, visibility: 'visible', appearance: { color: '#aabbcc', roughness: 0.3 }, contactWallSide: 'image_right', rearFeature: { name: '背板', bbox: [0.4, 0.4, 0.5, 0.5] }, bodyExtendsToward: 'image_left', coordinates3d: [9, 9, 9] }],
    people: [{ id: 'actor', name: '人物', bbox: [0.4, 0.3, 0.6, 0.8], confidence: 0.7, visibility: 'visible', posture: 'kneel', facingDirection: 'image_up', kneelVariant: 'seiza', handGesture: 'prayer', worldPosition: [9, 9, 9] }],
    globalYaw: 180,
  };
  let calls = 0;
  let providerPayload;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    calls += 1;
    providerPayload = JSON.parse(String(options?.body));
    return Response.json({ choices: [{ message: { content: JSON.stringify(observation) } }], usage: { total_tokens: 10 } });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const response = await call('/api/director-layout', {
    method: 'POST', token, env: layoutEnv,
    body: { outputFormat: DIRECTOR_LAYOUT_OBSERVATION_FORMAT, image: { url: 'data:image/png;base64,AA==' } },
  });
  assert.equal(response.status, 200);
  assert.equal(calls, 1);
  assert.equal(providerPayload.messages[0].role, 'system');
  assert.match(providerPayload.messages[0].content, /只负责从参考图提取可见的二维视觉事实/);
  assert.match(providerPayload.messages[0].content, /每个人物都必须输出 posture/);
  assert.match(providerPayload.messages[0].content, /不确定时必须显式写 unknown/);
  assert.match(providerPayload.messages[0].content, /不能从跪姿或人物名称推断/);
  assert.match(providerPayload.messages[0].content, /facingDirection/);
  assert.match(providerPayload.messages[0].content, /toward_camera\/away_from_camera/);
  assert.match(providerPayload.messages[0].content, /supportId/);
  const data = await response.json();
  assert.equal(data.observationFormat, DIRECTOR_LAYOUT_OBSERVATION_FORMAT);
  assert.deepEqual(data.visualObservations, {
    spaceType: 'open',
    surfaces: [{ id: 'wall', kind: 'wall', side: 'image_back', bbox: [0, 0.1, 1, 0.8], confidence: 0.9 }],
    items: [{ id: 'desk', name: '桌子', semanticType: 'desk', bbox: [0.2, 0.4, 0.6, 0.7], confidence: 0.8, visibility: 'visible', mainColor: '#AABBCC', contactWallSide: 'image_right', rearFeature: { name: '背板', bbox: [0.4, 0.4, 0.5, 0.5] }, bodyExtendsToward: 'image_left' }],
    people: [{ id: 'actor', name: '人物', bbox: [0.4, 0.3, 0.6, 0.8], confidence: 0.7, visibility: 'visible', posture: 'kneel', facingDirection: 'image_up', kneelVariant: 'seiza', handGesture: 'prayer' }],
  });
  assert.equal(data.providerOutputShape.itemsItems[0].types.appearance, 'object');
  assert.equal(data.providerOutputShape.itemsItems[0].appearance.types.color, 'string');
  assert.deepEqual(data.usage, { total_tokens: 10 });
});

test('image observation parser rejects unbounded arrays and malformed boxes', () => {
  assert.throws(() => parseDirectorLayoutObservation(JSON.stringify({ surfaces: [], items: Array(31).fill({}) })), /结构无效/);
  assert.throws(() => parseDirectorLayoutObservation(JSON.stringify({
    surfaces: [], items: [{ id: 'bad', name: '物件', category: 'prop', bbox: [-1, 0, 0.2, 0.3], confidence: 0.8, visibility: 'visible' }],
  })), /对象无效/);
});

test('image observation parser requires explicit posture and preserves unknown without guessing', () => {
  const basePerson = { id: 'actor', name: '跪拜女子', bbox: [0.2, 0.2, 0.4, 0.9], confidence: 0.9, visibility: 'visible' };
  assert.throws(() => parseDirectorLayoutObservation(JSON.stringify({ surfaces: [], items: [], people: [basePerson] })), /对象无效/);
  const parsed = parseDirectorLayoutObservation(JSON.stringify({ surfaces: [], items: [], people: [{ ...basePerson, posture: 'unknown', facingDirection: 'unknown' }] }));
  assert.equal(parsed.people[0].posture, 'unknown');
  assert.equal(parsed.people[0].facingDirection, 'unknown');
  assert.throws(() => parseDirectorLayoutObservation(JSON.stringify({ surfaces: [], items: [], people: [{ ...basePerson, posture: 'kneel', facingDirection: 'unknown' }] })), /对象无效/);
  assert.throws(() => parseDirectorLayoutObservation(JSON.stringify({ surfaces: [], items: [], people: [{ ...basePerson, posture: 'unknown', facingDirection: 'unknown', visibility: 'partly_occluded', handGesture: 'prayer' }] })), /对象无效/);
  assert.throws(() => parseDirectorLayoutObservation(JSON.stringify({ surfaces: [], items: [], people: [{ ...basePerson, visibility: 'partly_occluded', posture: 'kneel', facingDirection: 'unknown', kneelVariant: 'seiza' }] })), /对象无效/);
});

test('image observation parser preserves camera-relative facing and person supportId', () => {
  const parsed = parseDirectorLayoutObservation(JSON.stringify({
    surfaces: [],
    items: [{ id: 'cushion', name: '坐垫', semanticType: 'cushion', bbox: [0.3, 0.6, 0.6, 0.75], confidence: 0.9, visibility: 'visible' }],
    people: [{ id: 'actor', name: '人物', bbox: [0.35, 0.25, 0.55, 0.65], confidence: 0.9, visibility: 'visible', posture: 'kneel', facingDirection: 'toward_camera', kneelVariant: 'seiza', supportId: 'cushion' }],
  }));
  assert.equal(parsed.people[0].facingDirection, 'toward_camera');
  assert.equal(parsed.people[0].supportId, 'cushion');
});

test('image observation parser normalizes bounded color aliases and preserves explicit unknown color', () => {
  const parsed = parseDirectorLayoutObservation(JSON.stringify({
    surfaces: [{ id: 'wall', kind: 'wall', side: 'image_back', bbox: [0, 0, 1, 0.8], confidence: 0.9, color: '#abcdef' }],
    items: [
      { id: 'desk', name: '桌', semanticType: 'desk', bbox: [0.2, 0.3, 0.8, 0.7], confidence: 0.9, visibility: 'visible', appearance: { color: '#123456', roughness: 0.4 } },
      { id: 'chair', name: '椅子', semanticType: 'chair', bbox: [0.2, 0.3, 0.4, 0.8], confidence: 0.8, visibility: 'visible', mainColor: null },
    ],
  }));
  assert.deepEqual(parsed.surfaces[0].mainColor, '#ABCDEF');
  assert.deepEqual(parsed.items.map((item) => item.mainColor), ['#123456', null]);
  assert.equal('appearance' in parsed.items[0], false);
});

test('image observation failures expose bounded paths and key/type shape without provider values', async (t) => {
  const token = await login();
  const bad = { surfaces: [], items: [{ id: 'secret-object-name', name: '机密文本', bbox: [0, 0, 1, 1], confidence: 0.8, visibility: 'visible' }] };
  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { calls += 1; return Response.json({ choices: [{ message: { content: JSON.stringify(bad) } }] }); };
  t.after(() => { globalThis.fetch = originalFetch; });
  const response = await call('/api/director-layout', {
    method: 'POST', token, env: layoutEnv,
    body: { outputFormat: DIRECTOR_LAYOUT_OBSERVATION_FORMAT, image: { url: 'data:image/png;base64,AA==' } },
  });
  const data = await response.json();
  assert.equal(response.status, 422);
  assert.equal(calls, 1);
  assert.equal(data.error, 'DIRECTOR_LAYOUT_MODEL_SCHEMA_INVALID');
  assert.ok(data.issuePaths.includes('$.items[0].semanticType|category:required'));
  assert.deepEqual(data.outputShape.rootKeys, ['surfaces', 'items']);
  assert.equal(data.outputShape.itemsItems[0].types.name, 'string');
  assert.equal(JSON.stringify(data).includes('secret-object-name'), false);
  assert.equal(JSON.stringify(data).includes('机密文本'), false);
  const summary = summarizeDirectorLayoutObservationOutput('{"token":"do-not-retain"}');
  assert.deepEqual(summary.rootKeys, []);
  assert.equal(summary.unknownRootKeyCount, 1);
  assert.equal(JSON.stringify(summary).includes('do-not-retain'), false);
});

test('director-layout distinguishes provider HTTP errors from model parsing failures', async (t) => {
  const token = await login();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: 'provider-secret-detail' } }), { status: 429 });
  t.after(() => { globalThis.fetch = originalFetch; });
  const response = await call('/api/director-layout', {
    method: 'POST', token, env: layoutEnv,
    body: { outputFormat: DIRECTOR_LAYOUT_OBSERVATION_FORMAT, image: { url: 'data:image/png;base64,AA==' } },
  });
  const data = await response.json();
  assert.equal(response.status, 429);
  assert.equal(data.error, 'DIRECTOR_LAYOUT_UPSTREAM_HTTP');
  assert.equal(data.upstreamStatus, 429);
  assert.equal(JSON.stringify(data).includes('provider-secret-detail'), false);
});

test('director-layout labels an invalid provider envelope separately and keeps only its shape', async (t) => {
  const token = await login();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ id: 'private-id', unexpected: 'secret', choices: [{ message: { content: null, private: 'text' } }] });
  t.after(() => { globalThis.fetch = originalFetch; });
  const response = await call('/api/director-layout', {
    method: 'POST', token, env: layoutEnv,
    body: { outputFormat: DIRECTOR_LAYOUT_OBSERVATION_FORMAT, image: { url: 'data:image/png;base64,AA==' } },
  });
  const data = await response.json();
  assert.equal(response.status, 502);
  assert.equal(data.error, 'DIRECTOR_LAYOUT_UPSTREAM_RESPONSE_INVALID');
  assert.equal(data.providerEnvelope.choices[0].message.types.content, 'null');
  assert.equal(JSON.stringify(data).includes('private-id'), false);
  assert.equal(JSON.stringify(data).includes('secret'), false);
});

test('director-layout accepts an assembly whose rotated bounds remain inside its parent component', async (t) => {
  const token = await login();
  const rotatedDraft = structuredClone(validDraft);
  rotatedDraft.components[0].assembly = [{ primitive: 'box', position: [0.5, 0.5, 0.5], size: [0.4, 0.2, 0.2], rotation: [0, 0, 45] }];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ choices: [{ message: { content: JSON.stringify(rotatedDraft) } }] });
  t.after(() => { globalThis.fetch = originalFetch; });
  const response = await call('/api/director-layout', { method: 'POST', token, env: layoutEnv, body: { image: { url: 'data:image/png;base64,AA==' } } });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).draft, rotatedDraft);
});

test('director-layout accepts a doorway aligned with the long axis of a Z-oriented wall', async (t) => {
  const token = await login();
  const rotatedDraft = structuredClone(validDraft);
  rotatedDraft.components = [
    {
      id: 'wall_left', name: '左墙', category: 'wall', primitive: 'box',
      position: [-3, 0, 0], size: [0.15, 2.8, 7], rotationYDegrees: 0,
      confidence: 0.8, uncertain: false,
    },
    {
      id: 'door_left', name: '门', category: 'door', primitive: 'box',
      position: [-3, 0, 0.9], size: [0.9, 2.05, 0.08], rotationYDegrees: 90,
      confidence: 0.75, uncertain: false,
    },
  ];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ choices: [{ message: { content: JSON.stringify(rotatedDraft) } }] });
  t.after(() => { globalThis.fetch = originalFetch; });
  const response = await call('/api/director-layout', { method: 'POST', token, env: layoutEnv, body: { image: { url: 'data:image/png;base64,AA==' } } });
  assert.equal(response.status, 200);
  const result = (await response.json()).draft;
  assert.deepEqual(result.components, rotatedDraft.components);
});

test('director-layout keeps a genuinely detached opening as an uncertain draft diagnostic', async (t) => {
  const token = await login();
  const draft = structuredClone(validDraft);
  draft.components.push({
    id: 'window_detached', name: '待确认窗', category: 'window', primitive: 'box',
    position: [5, 0.8, 0], size: [1, 1, 0.08], rotationYDegrees: 0,
    confidence: 0.8, uncertain: false,
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ choices: [{ message: { content: JSON.stringify(draft) } }] });
  t.after(() => { globalThis.fetch = originalFetch; });
  const response = await call('/api/director-layout', { method: 'POST', token, env: layoutEnv, body: { image: { url: 'data:image/png;base64,AA==' } } });
  assert.equal(response.status, 200);
  const opening = (await response.json()).draft.components.find((item) => item.id === 'window_detached');
  assert.equal(opening.position[0], 5);
  assert.equal(opening.uncertain, true);
  assert.match(opening.notes, /窗未依附可识别墙面，待确认位置与朝向/);
});

test('director-layout rejects a rotated assembly that escapes its parent bounds and requests one correction', async (t) => {
  const token = await login();
  let modelCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    modelCalls += 1;
    if (modelCalls === 1) {
      const invalid = structuredClone(validDraft);
      invalid.components[0].assembly = [{ primitive: 'box', position: [0.12, 0.5, 0.5], size: [0.4, 0.2, 0.2], rotation: [0, 0, 45] }];
      return Response.json({ choices: [{ message: { content: JSON.stringify(invalid) } }] });
    }
    assert.match(JSON.parse(init.body).messages[1].content[1].text, /assembly/);
    return Response.json({ choices: [{ message: { content: JSON.stringify(validDraft) } }] });
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const response = await call('/api/director-layout', { method: 'POST', token, env: layoutEnv, body: { image: { url: 'data:image/png;base64,AA==' } } });
  assert.equal(response.status, 200);
  assert.equal(modelCalls, 2);
});

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
    assert.match(systemPrompt, /head_at 关系必须 fromId=床体组件（semanticType="bed"）、toId=该床所属 wall/);
    assert.match(systemPrompt, /现有可复用 semanticType 预设为 bed、curtain、bookshelf/);
    assert.match(systemPrompt, /不要把这些预设内部子部件重复输出为同级 components/);
    assert.match(systemPrompt, /head_at 必须从床体组件（semanticType=bed）指向所属 wall/);
    assert.match(systemPrompt, /spaceType：enclosed.*open.*outdoor.*unknown/);
    assert.match(systemPrompt, /最多输出12条 observations/);
    assert.match(systemPrompt, /最多24条 relations/);
    assert.match(systemPrompt, /left_of\/right_of 永远表示原图观察者视角/);
    assert.match(systemPrompt, /semanticType="bed"/);
    assert.match(systemPrompt, /主色明确可辨的组件，必须输出 appearance\.color 近似值/);
    assert.match(systemPrompt, /示例 appearance 结构：\{"color":"#8A6741","roughness":0\.7,"metalness":0\.0\}/);
    assert.match(systemPrompt, /没有可用预设、但可见轮廓明确由多个主要部分组成的物件，应使用少量有证据的 assembly 子件表达/);
    assert.match(systemPrompt, /单个组件建议不超过8件/);
    assert.match(systemPrompt, /只识别这些 category：ground, wall, door, window, table, chair, sofa, cabinet, pillar, prop/);
    assert.match(systemPrompt, /桌台上的香炉、花瓶、雕像等 prop 的 Y=承载台面高度/);
    assert.match(systemPrompt, /落地 wall、pillar 的 position\.y 通常等于地面高度 0，而不是 size\[1\]\/2/);
    assert.match(systemPrompt, /window、桌面 prop 等悬空物体仍写真实支撑面高度，不得统一贴地/);
    assert.match(systemPrompt, /supportComponentId=承载组件 id/);
    assert.match(systemPrompt, /不要用 wall\/window\/door\/pillar 作为水平支撑/);
    assert.match(systemPrompt, /chair\/sofa 的包围盒顶通常不是座面/);
    assert.match(systemPrompt, /kneelVariant：one-knee（单膝跪）, two-knee（双膝直身跪）, seiza/);
    assert.match(systemPrompt, /佛像.*不得写入 characters/);
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

test('director-layout rejects a cyclic support graph and requests one correction', async (t) => {
  const token = await login();
  let modelCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    modelCalls += 1;
    if (modelCalls === 1) {
      const cyclicDraft = {
        ...validDraft,
        components: [
          { ...validDraft.components[0], id: 'prop_a', category: 'prop', supportComponentId: 'prop_b' },
          { ...validDraft.components[0], id: 'prop_b', category: 'prop', supportComponentId: 'prop_a' },
        ],
      };
      return Response.json({ choices: [{ message: { content: JSON.stringify(cyclicDraft) } }] });
    }
    const payload = JSON.parse(init.body);
    assert.match(payload.messages[1].content[1].text, /支撑关系形成循环/);
    return Response.json({ choices: [{ message: { content: JSON.stringify(validDraft) } }] });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const response = await call('/api/director-layout', {
    method: 'POST',
    token,
    env: { ...baseEnv, DIRECTOR_LAYOUT_API_KEY: 'test-key' },
    body: { image: { url: 'https://example.com/support-cycle.png' } },
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

test('director-layout corrects a fresh model response that omits characters', async (t) => {
  const token = await login();
  let modelCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    modelCalls += 1;
    if (modelCalls === 1) {
      const { characters: _characters, ...withoutCharacters } = validDraft;
      return Response.json({ choices: [{ message: { content: JSON.stringify(withoutCharacters) } }] });
    }
    const payload = JSON.parse(init.body);
    assert.match(payload.messages[1].content[1].text, /缺少 characters 数组/);
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
  assert.equal(modelCalls, 2);
  assert.deepEqual((await response.json()).draft.characters, []);
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
