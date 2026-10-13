const TOKEN_TTL_SECONDS = 60 * 60 * 24 * 7;

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  },
});

const base64UrlEncodeBytes = (bytes) => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
};

const base64UrlEncodeText = (text) => {
  return base64UrlEncodeBytes(new TextEncoder().encode(text));
};

const base64UrlDecodeText = (value) => {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
};

const hmacKey = (secret) => crypto.subtle.importKey(
  'raw',
  new TextEncoder().encode(secret),
  { name: 'HMAC', hash: 'SHA-256' },
  false,
  ['sign'],
);

const sign = async (payload, secret) => {
  const key = await hmacKey(secret);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return base64UrlEncodeBytes(new Uint8Array(signature));
};

const secureEqual = (left, right) => {
  if (left.length !== right.length) return false;
  let result = 0;
  for (let index = 0; index < left.length; index += 1) {
    result |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return result === 0;
};

const createToken = async (env) => {
  const secret = env.AUTH_SECRET || 'kc-canvas-dev-secret-change-me';
  const payload = base64UrlEncodeText(JSON.stringify({
    sub: 'kc-user',
    exp: Math.floor(Date.now() / 1000) + Number(env.AUTH_TOKEN_TTL_SECONDS || TOKEN_TTL_SECONDS),
  }));
  return `${payload}.${await sign(payload, secret)}`;
};

const verifyToken = async (token, env) => {
  try {
    if (!token || !token.includes('.')) return false;
    const [payload, signature] = token.split('.');
    const expected = await sign(payload, env.AUTH_SECRET || 'kc-canvas-dev-secret-change-me');
    if (!secureEqual(signature, expected)) return false;
    const data = JSON.parse(base64UrlDecodeText(payload));
    return data.exp > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
};

const requireAuth = async (request, env) => {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  return verifyToken(token, env);
};

const joinUrl = (baseUrl, endpoint) => {
  const base = (baseUrl || '').replace(/\/$/, '');
  const pathPart = (endpoint || '').startsWith('/') ? endpoint : `/${endpoint || ''}`;
  return `${base}${pathPart}`;
};

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const isTimeoutLikeError = (error) => {
  const message = String(error?.message || '').toLowerCase();
  return error?.statusCode === 408
    || error?.statusCode === 524
    || error?.name === 'AbortError'
    || message.includes('524')
    || message.includes('timeout')
    || message.includes('timed out');
};

const mediaExtension = (mimeType) => {
  const normalized = String(mimeType || '').toLowerCase();
  if (normalized === 'image/jpeg' || normalized === 'image/jpg') return 'jpg';
  if (normalized === 'image/png') return 'png';
  if (normalized === 'image/webp') return 'webp';
  return 'bin';
};

const parseImageDataUrl = (dataUrl) => {
  const match = String(dataUrl || '').match(/^data:(image\/(?:png|jpeg|jpg|webp));base64,([a-zA-Z0-9+/=\r\n]+)$/);
  if (!match) throw new Error('MEDIA_UPLOAD_INVALID_IMAGE');
  const mimeType = match[1] === 'image/jpg' ? 'image/jpeg' : match[1];
  const binary = atob(match[2].replace(/\s/g, ''));
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return { mimeType, bytes };
};

const publicOrigin = (request, env) => {
  return (env.MEDIA_PUBLIC_BASE_URL || new URL(request.url).origin).replace(/\/$/, '');
};

const handleMediaUpload = async (request, env) => {
  if (request.method !== 'POST') return json({ error: 'METHOD_NOT_ALLOWED' }, 405);
  if (!(await requireAuth(request, env))) return json({ error: 'UNAUTHORIZED' }, 401);
  const body = await request.json().catch(() => ({}));
  const { mimeType, bytes } = parseImageDataUrl(body.dataUrl);
  const maxBytes = Number(env.MEDIA_UPLOAD_MAX_BYTES) || 12 * 1024 * 1024;
  if (bytes.byteLength > maxBytes) return json({ error: 'MEDIA_UPLOAD_TOO_LARGE' }, 413);

  const key = `temp/${crypto.randomUUID()}.${mediaExtension(mimeType)}`;
  const url = `${publicOrigin(request, env)}/api/media/${key}`;

  if (env.MEDIA_BUCKET?.put) {
    await env.MEDIA_BUCKET.put(key, bytes, {
      httpMetadata: { contentType: mimeType, cacheControl: 'public, max-age=86400' },
    });
    return json({ url, key });
  }

  if (typeof caches !== 'undefined' && caches.default) {
    await caches.default.put(new Request(url), new Response(bytes, {
      headers: {
        'Content-Type': mimeType,
        'Cache-Control': 'public, max-age=86400',
      },
    }));
    return json({ url, key, cacheOnly: true });
  }

  return json({ error: 'MEDIA_BUCKET_NOT_CONFIGURED' }, 501);
};

const handleMediaGet = async (request, env, pathname) => {
  const key = decodeURIComponent(pathname.replace('/api/media/', ''));
  if (!key || key.includes('..')) return json({ error: 'MEDIA_NOT_FOUND' }, 404);

  if (env.MEDIA_BUCKET?.get) {
    const object = await env.MEDIA_BUCKET.get(key);
    if (!object) return json({ error: 'MEDIA_NOT_FOUND' }, 404);
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set('Cache-Control', 'public, max-age=86400');
    return new Response(object.body, { headers });
  }

  if (typeof caches !== 'undefined' && caches.default) {
    const cached = await caches.default.match(request);
    if (cached) return cached;
  }

  return json({ error: 'MEDIA_NOT_FOUND' }, 404);
};

const seedreamSize = (resolution = '2k') => {
  const normalized = String(resolution || '').toLowerCase();
  if (normalized.includes('4')) return '4K';
  if (normalized.includes('1')) return '1K';
  return '2K';
};

const angleLabels = {
  front: '正面',
  left_45: '左前45°',
  right_45: '右前45°',
  left_side: '左侧面',
  right_side: '右侧面',
  back: '背面',
  top: '俯视',
  low: '仰视',
  custom: '自定义视角',
  fisheye: '鱼眼视角',
  tilt: '倾斜视角',
  front_top: '正面俯拍',
  front_low: '正面仰拍',
  panorama_top: '全景俯拍',
  back_view: '背面视角',
};

const angleInstructions = {
  front: '正面视角',
  left_45: '左前45度视角',
  right_45: '右前45度视角',
  left_side: '左侧面视角',
  right_side: '右侧面视角',
  back: '背面视角',
  top: '俯视视角',
  low: '低机位仰视视角',
  custom: '自定义相机视角',
  fisheye: '鱼眼广角视角',
  tilt: '倾斜构图视角',
  front_top: '正面俯拍视角',
  front_low: '正面仰拍视角',
  panorama_top: '全景俯拍视角',
  back_view: '背面视角',
};

const backgroundInstructions = {
  keep: '尽量保留原图背景和光线关系。',
  clean: '使用干净背景并保持完整画面空间关系，画面清晰自然。',
  solid: '使用简洁纯色背景，避免复杂环境元素。',
};

const aspectToQwenSize = (aspectRatio) => {
  const sizes = {
    '1:1': '1024*1024',
    '3:4': '960*1280',
    '4:3': '1280*960',
    '9:16': '864*1536',
    '16:9': '1536*864',
  };
  return sizes[aspectRatio] || '';
};

const zoomInstructions = {
  wide: '全景景别，视野更宽，保留更多环境信息。',
  medium: '中景景别，保持自然视野范围。',
  close: '近景景别，适度靠近画面中心但不要裁掉关键空间关系。',
};

const buildMultiAnglePrompt = ({ angle, prompt = '', consistency = 'high', background = 'clean', yaw = 0, pitch = 0, zoom = 'medium', targetMode = 'scene' }) => {
  const targetText = targetMode === 'subject'
    ? '围绕图1中的主要主体进行视角变化。'
    : '对图1的整张图片、完整场景和相机视角进行变化，不要把人物、物品或局部主体单独抠出，不要改变为孤立主体图。';
  const consistencyText = consistency === 'high'
    ? '严格保持原图的空间布局、人物/物体相对位置、场景结构、材质、颜色和关键细节一致。'
    : '保持原图的主要场景结构、元素关系、颜色和材质一致。';
  const yawText = yaw > 0 ? `相机向右水平环绕约${yaw}度。` : yaw < 0 ? `相机向左水平环绕约${Math.abs(yaw)}度。` : '水平视角保持正向。';
  const pitchText = pitch > 0 ? `相机向下俯拍约${pitch}度。` : pitch < 0 ? `相机向上仰拍约${Math.abs(pitch)}度。` : '垂直俯仰保持水平。';
  return [
    `基于图1生成${angleInstructions[angle] || angle}。`,
    targetText,
    yawText,
    pitchText,
    zoomInstructions[zoom] || zoomInstructions.medium,
    consistencyText,
    backgroundInstructions[background] || backgroundInstructions.clean,
    '输出必须是单张完整画面，不要生成拼贴图或多宫格，不要只返回局部主体。',
    prompt ? `补充要求：${prompt}` : '',
  ].filter(Boolean).join('');
};

const bytesToBase64 = (bytes) => {
  let binary = '';
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
};

const mockAudio = ({ text = '' }) => {
  const sampleRate = 16000;
  const durationSeconds = Math.max(0.8, Math.min(4, String(text || '').length / 18 || 1.2));
  const sampleCount = Math.floor(sampleRate * durationSeconds);
  const bytes = new Uint8Array(44 + sampleCount * 2);
  const view = new DataView(bytes.buffer);
  const writeString = (offset, value) => {
    for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index));
  };
  writeString(0, 'RIFF');
  view.setUint32(4, 36 + sampleCount * 2, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, sampleCount * 2, true);
  const seed = Array.from(String(text || 'kc audio')).reduce((sum, char) => sum + char.charCodeAt(0), 0);
  const frequency = 180 + (seed % 220);
  for (let index = 0; index < sampleCount; index += 1) {
    const fadeIn = Math.min(1, index / (sampleRate * 0.08));
    const fadeOut = Math.min(1, (sampleCount - index) / (sampleRate * 0.12));
    const envelope = Math.min(fadeIn, fadeOut) * 0.26;
    const sample = Math.sin((2 * Math.PI * frequency * index) / sampleRate) * envelope;
    view.setInt16(44 + index * 2, Math.max(-1, Math.min(1, sample)) * 32767, true);
  }
  return `data:audio/wav;base64,${bytesToBase64(bytes)}`;
};

const hexToBase64 = (hex = '') => {
  const clean = String(hex).replace(/\s+/g, '');
  if (!/^[a-f0-9]+$/i.test(clean) || clean.length % 2 !== 0) return '';
  const bytes = new Uint8Array(clean.length / 2);
  for (let index = 0; index < clean.length; index += 2) {
    bytes[index / 2] = parseInt(clean.slice(index, index + 2), 16);
  }
  return bytesToBase64(bytes);
};

const extractUrls = (data) => {
  const urls = [];
  const visit = (value) => {
    if (!value) return;
    if (typeof value === 'string') {
      if (/^(https?:|data:image|data:video|data:audio|blob:)/.test(value)) urls.push(value);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (typeof value === 'object') {
      if (value.b64_json) urls.push(`data:image/png;base64,${value.b64_json}`);
      if (value.image) visit(value.image);
      if (value.url) visit(value.url);
      if (value.image_url) visit(value.image_url);
      if (value.video_url) visit(value.video_url);
      if (value.output_url) visit(value.output_url);
      if (value.data) visit(value.data);
      if (value.result) visit(value.result);
      if (value.output) visit(value.output);
      if (value.content) visit(value.content);
      for (const nested of Object.values(value)) visit(nested);
    }
  };
  visit(data);
  return [...new Set(urls)];
};

const extractAudioUrls = (data) => {
  const urls = extractUrls(data).filter(url => /^(data:audio)/.test(url) || /\.(mp3|wav|m4a|aac|ogg|flac)(\?|$)/i.test(url));
  const candidates = [
    data?.data?.audio,
    data?.data?.audio_url,
    data?.data?.url,
    data?.audio,
    data?.audio_url,
    data?.url,
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    if (/^(https?:|data:audio|blob:)/.test(candidate)) {
      urls.push(candidate);
      continue;
    }
    const hexAudio = hexToBase64(candidate);
    if (hexAudio) urls.push(`data:audio/mpeg;base64,${hexAudio}`);
  }
  return [...new Set(urls)];
};

const resolveMinimaxSpeechModel = (modelName, env) => {
  const value = String(modelName || '').toLowerCase();
  if (value.includes('2.8')) return 'speech-2.8-hd';
  return env.MINIMAX_TTS_MODEL_ID || env.AUDIO_MODEL_ID || 'speech-2.8-hd';
};

const getMinimaxTtsEndpoint = (env) => {
  const endpoint = env.MINIMAX_TTS_ENDPOINT || env.AUDIO_ENDPOINT || '/v1/t2a_v2';
  const groupId = env.MINIMAX_GROUP_ID || env.MINIMAX_TTS_GROUP_ID;
  if (!groupId || /[?&]GroupId=/.test(endpoint)) return endpoint;
  return `${endpoint}${endpoint.includes('?') ? '&' : '?'}GroupId=${encodeURIComponent(groupId)}`;
};

const buildMinimaxSpeechPayload = (body, env) => ({
  model: resolveMinimaxSpeechModel(body.modelName || body.model, env),
  text: String(body.text || body.prompt || '').slice(0, 50000),
  stream: false,
  voice_setting: {
    voice_id: body.voiceId || env.MINIMAX_TTS_VOICE_ID || 'male-qn-qingse',
    speed: Number(body.speed || 1),
    vol: Number(body.volume || 1),
    pitch: Number(body.pitch || 0),
  },
  audio_setting: {
    sample_rate: Number(env.MINIMAX_TTS_SAMPLE_RATE || 32000),
    bitrate: Number(env.MINIMAX_TTS_BITRATE || 128000),
    format: env.MINIMAX_TTS_FORMAT || 'mp3',
    channel: Number(env.MINIMAX_TTS_CHANNEL || 1),
  },
});

const callModelApi = async ({ baseUrl, endpoint, apiKey, payload, timeoutMs = 300000 }) => {
  const cleanApiKey = String(apiKey || '').trim();
  if (!baseUrl || !cleanApiKey) throw new Error('MODEL_API_NOT_CONFIGURED');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(joinUrl(baseUrl, endpoint), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cleanApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const text = await response.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }
    if (!response.ok) {
      const error = new Error(data?.error?.message || data?.message || data?.code || data?.raw || `MODEL_API_${response.status}`);
      error.statusCode = response.status;
      throw error;
    }
    return data;
  } catch (error) {
    if (error?.name === 'AbortError' || controller.signal.aborted) {
      const timeoutError = new Error(`MODEL_API_TIMEOUT_${Math.round(timeoutMs / 1000)}S`);
      timeoutError.statusCode = 408;
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
};

const callTextModelApi = async ({ baseUrl, endpoint, apiKey, payload, timeoutMs = 600000 }) => {
  try {
    return await callModelApi({ baseUrl, endpoint, apiKey, payload, timeoutMs });
  } catch (error) {
    if (!isTimeoutLikeError(error)) throw error;
    await sleep(1200);
    const retryPayload = {
      ...payload,
      max_completion_tokens: Math.min(Number(payload.max_completion_tokens) || 2048, 2048),
    };
    try {
      return await callModelApi({ baseUrl, endpoint, apiKey, payload: retryPayload, timeoutMs });
    } catch (retryError) {
      if (isTimeoutLikeError(retryError)) {
        const timeoutError = new Error('MIMO_TEXT_TIMEOUT: 当前文本生成耗时过长，请缩短输入或拆分成多段生成。');
        timeoutError.statusCode = 524;
        throw timeoutError;
      }
      throw retryError;
    }
  }
};

const getQwenEditApiKey = (env) => (
  env.DASHSCOPE_API_KEY ||
  env.QWEN_EDIT_API_KEY ||
  env.ALIYUN_DASHSCOPE_API_KEY ||
  env.DASHSCOPE_KEY
);

const extractText = (data) => {
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(part => part?.text || part?.content || '').filter(Boolean).join('\n');
  }
  return '';
};

const MEDIA_ANALYSIS_SYSTEM_PROMPT = [
  '你是专业的影视广告视觉分析师和AI生成提示词工程师。',
  '当输入是图片时，完整分析画面构成，并输出可用于复刻该图片的生成提示词。',
  '当输入是视频时，按时间顺序拆解为完整分镜表，覆盖画面、镜头、运动、主体、场景、光线、色彩、声音和可复刻的视频生成提示词。',
  '输出使用中文，结构清晰，避免泛泛形容，尽量描述可观察的视觉事实。'
].join('\n');

// Keep this prompt and validation contract in sync with server/server.mjs.
const DIRECTOR_LAYOUT_SYSTEM_PROMPT = [
  '你是 3D 影视预演的室内粗布景与人物占位分析器。',
  '只依据一张参考图估计可编辑的粗布景和人物，不要虚构图中不可见的精细结构。',
  '========== 第一部分：布景组件 components ==========',
  '只识别这些 category：ground, wall, door, window, table, chair, sofa, cabinet。',
  '只使用这些 primitive：box, cylinder。不要返回模型名、GLB、纹理或外部资产。',
  '床不是合法 category：如图中有床，床体用 sofa + box 表示，床头板用独立 cabinet + box 表示；在 name/notes 标明“床体”或“床头板”，不要输出 bed。',
  '共享右手世界基准以参考机位为准：+X 为画面右，+Y 向上，+Z 朝观察者/默认机位，-Z 为后墙方向。透视倾斜时，依据墙线和消失方向判断房间轴；不要把屏幕二维左右、上下或像素距离直接当作世界距离或米。',
  '坐标单位是米；position 是物体底面中心；size 顺序是局部宽、高、深，且每项必须大于 0。yaw=0 时局部 width 沿 +X、local depth 沿 +Z；正 rotationYDegrees 使 local +Z 转向 +X。size 只写局部尺寸，rotationYDegrees 只写朝向，不能把宽深旋转两次。',
  '柜体或有开口面的家具，局部正面/开放面定义为 local +Z；床体的床头定义在 local -Z，床头板与床体分别输出并邻近该端。普通 box 的前后或 +/-180 度视觉不可区分时，在 notes 写明朝向依据或不确定性，不要假装可从对称外形恢复。',
  '先识别空间关系，再填写坐标：门、窗依附所在墙面；门洞附近的墙应拆成门洞左右或上方的墙段，不要用一整块墙堵住门洞；家具长轴、柜开放面、床头端与相邻墙/家具的关系要自洽。床头柜（cabinet）应靠近床头端，并按图判断其在床的哪一侧。以上是一般关系规则，不能硬编码为某个卧室。',
  '最多 30 个组件。无法确认的物体请降低 confidence 并设置 uncertain=true。',
  '========== 第二部分：人物 characters ==========',
  '识别图中所有人物，最多 8 个；人物要创建为可编辑的角色占位，只做站位与姿态，不要还原脸、服装和体型。',
  'posture 只能取：stand（站）, sit（坐）, crouch（蹲）, kneel（跪）, lie（躺/卧）, unknown（看不清）。',
  'bodyTypeHint 只能取：male, female, unknown。',
  'position 是"身体与支撑面的接触中心"，Y 必须等于支撑面高度：站/蹲站地面时 Y=0，坐在沙发或椅子上时 Y=该座面高度（约 0.40~0.50），躺在床上时 Y=床面高度。绝对不要把所有人物的 Y 都写成 0。',
  'rotationYDegrees 是人物面朝方向，0 表示面朝 +Z（朝向默认机位），90 表示面朝 +X，-90 表示面朝 -X，180 表示背对机位。',
  '========== 尺度：最关键的要求 ==========',
  '整张图只能使用一次统一的比例尺（uniform scale）。先依据深度、遮挡、地面、墙线和可见连接关系估计三维比例：原图中约 1:10 的关系不能被常识改成 1:5；远处物体像素更小可能来自透视，不等于它在三维中更小。禁止逐个物体按常见尺寸重新缩放。',
  '无人图：只根据可见建筑、家具和空间关系选择尺度锚点，不要虚构人物。有人图：人物、家具和空间共用同一把尺；优先以可见的已知尺度锚点校准，坐姿、遮挡或局部人物不可强制当作站立 1.7 米。',
  '成年人身高、门高、座面高、沙发宽、餐桌高等常识只用于选择或校验统一尺度，不能覆盖图中已观察到的相对关系。参考范围：站立成年人约 1.6~1.8 米、坐姿座面到头顶约 0.9 米、座面约 0.45 米、标准门高约 2.05 米。',
  'height 是人物估算身高，必须在 0.5 到 2.5 米之间；看不清时保留同一尺度下的估计并降低 confidence/设置 uncertain=true，不要用默认成年身高破坏图中比例。',
  '========== 输出格式 ==========',
  'scale.mode 固定为 estimated。没有要创建的人物时输出空数组 characters: []，不要省略该字段。',
  '无法确认的人物请降低 confidence 并设置 uncertain=true（例如被遮挡、只露出部分身体）。',
  '只输出一个 JSON 对象，不要 Markdown，不要解释。格式：',
  '{"scale":{"mode":"estimated","confidence":0.4},"components":[{"id":"wall_01","name":"后墙","category":"wall","primitive":"box","position":[0,0,-3],"size":[6,2.8,0.15],"rotationYDegrees":0,"confidence":0.8,"uncertain":false,"notes":""}],"characters":[{"id":"char_01","name":"人物甲","position":[-0.6,0.45,0.2],"height":1.7,"rotationYDegrees":15,"posture":"sit","bodyTypeHint":"male","confidence":0.7,"uncertain":false,"notes":"坐在沙发左侧"}]}'
].join('\n');

const DIRECTOR_LAYOUT_CATEGORIES = new Set(['ground', 'wall', 'door', 'window', 'table', 'chair', 'sofa', 'cabinet']);
const DIRECTOR_LAYOUT_PRIMITIVES = new Set(['box', 'cylinder']);
const DIRECTOR_LAYOUT_POSTURES = new Set(['stand', 'sit', 'crouch', 'kneel', 'lie', 'unknown']);
const DIRECTOR_LAYOUT_BODY_HINTS = new Set(['male', 'female', 'unknown']);
const DIRECTOR_LAYOUT_CHARACTER_MAX_COUNT = 8;
const DIRECTOR_LAYOUT_CHARACTER_MIN_HEIGHT = 0.5;
const DIRECTOR_LAYOUT_CHARACTER_MAX_HEIGHT = 2.5;

const parseDirectorLayoutJson = (text) => {
  const stripped = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(stripped);
  } catch {
    const error = new Error('模型没有返回可解析的 JSON');
    error.issues = [error.message];
    throw error;
  }
};

const validateDirectorLayoutCandidate = (candidate) => {
  const issues = [];
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    issues.push('布局结果必须是 JSON 对象');
  }
  const components = Array.isArray(candidate?.components) ? candidate.components : null;
  if (!components) issues.push('布局结果缺少 components 数组');
  if (components && components.length === 0) issues.push('没有识别到可用的粗布景组件');
  if (components && components.length > 30) issues.push('组件数量超过 30 个上限');
  const ids = new Set();
  components?.forEach((item, index) => {
    const label = `第 ${index + 1} 个组件`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      issues.push(`${label}不是对象`);
      return;
    }
    if (!DIRECTOR_LAYOUT_CATEGORIES.has(item.category)) issues.push(`${label}包含未知类型 ${String(item.category)}`);
    if (!DIRECTOR_LAYOUT_PRIMITIVES.has(item.primitive)) issues.push(`${label}包含未知基础资产 ${String(item.primitive)}`);
    const finiteTuple = (value) => Array.isArray(value) && value.length === 3
      && value.every(number => typeof number === 'number' && Number.isFinite(number));
    if (!finiteTuple(item.position)) issues.push(`${label}的位置必须是三个有限数字`);
    if (!finiteTuple(item.size)) issues.push(`${label}的尺寸必须是三个有限数字`);
    else if (item.size.some(number => number <= 0 || number > 100)) issues.push(`${label}的尺寸必须大于 0 且不超过 100 米`);
    if (typeof item.rotationYDegrees !== 'number' || !Number.isFinite(item.rotationYDegrees)) {
      issues.push(`${label}的朝向必须是有限数字`);
    }
    if (typeof item.confidence !== 'number' || !Number.isFinite(item.confidence) || item.confidence < 0 || item.confidence > 1) {
      issues.push(`${label}的置信度必须在 0 到 1 之间`);
    }
    const id = typeof item.id === 'string' ? item.id.trim() : '';
    if (!id) issues.push(`${label}缺少 id`);
    else if (ids.has(id)) issues.push(`${label}的 id 重复`);
    ids.add(id);
  });

  // characters 可选；存在则严格校验（客户端 schema 有宽容夹紧兜底，此处严格以便触发重试纠正）
  const rawCharacters = candidate?.characters;
  if (rawCharacters !== undefined && !Array.isArray(rawCharacters)) {
    issues.push('characters 必须是数组');
  }
  const characters = Array.isArray(rawCharacters) ? rawCharacters : null;
  if (characters && characters.length > DIRECTOR_LAYOUT_CHARACTER_MAX_COUNT) {
    issues.push(`人物数量超过 ${DIRECTOR_LAYOUT_CHARACTER_MAX_COUNT} 个上限`);
  }
  const characterIds = new Set();
  characters?.forEach((item, index) => {
    const label = `第 ${index + 1} 个人物`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      issues.push(`${label}不是对象`);
      return;
    }
    const finiteTuple = (value) => Array.isArray(value) && value.length === 3
      && value.every(number => typeof number === 'number' && Number.isFinite(number));
    if (!finiteTuple(item.position)) issues.push(`${label}的位置必须是三个有限数字`);
    if (typeof item.height !== 'number' || !Number.isFinite(item.height)
      || item.height < DIRECTOR_LAYOUT_CHARACTER_MIN_HEIGHT || item.height > DIRECTOR_LAYOUT_CHARACTER_MAX_HEIGHT) {
      issues.push(`${label}的身高必须是 ${DIRECTOR_LAYOUT_CHARACTER_MIN_HEIGHT} 到 ${DIRECTOR_LAYOUT_CHARACTER_MAX_HEIGHT} 米之间的数字`);
    }
    if (!DIRECTOR_LAYOUT_POSTURES.has(item.posture)) issues.push(`${label}包含未知姿态 ${String(item.posture)}`);
    if (!DIRECTOR_LAYOUT_BODY_HINTS.has(item.bodyTypeHint)) issues.push(`${label}包含未知体型 ${String(item.bodyTypeHint)}`);
    if (typeof item.rotationYDegrees !== 'number' || !Number.isFinite(item.rotationYDegrees)) {
      issues.push(`${label}的朝向必须是有限数字`);
    }
    if (typeof item.confidence !== 'number' || !Number.isFinite(item.confidence) || item.confidence < 0 || item.confidence > 1) {
      issues.push(`${label}的置信度必须在 0 到 1 之间`);
    }
    const id = typeof item.id === 'string' ? item.id.trim() : '';
    if (!id) issues.push(`${label}缺少 id`);
    else if (characterIds.has(id)) issues.push(`${label}的 id 重复`);
    characterIds.add(id);
  });

  if (issues.length) {
    const error = new Error(issues[0]);
    error.issues = issues;
    throw error;
  }
  return candidate;
};

const DEFAULT_SCRIPT_ASSET_SYSTEM_PROMPT = [
  '你是影视前期视觉资产拆解专家。你的任务是根据用户剧本，为每个主要角色输出完整、稳定、可复用的 AI 角色资产提示词。',
  '执行顺序必须固定：通读剧本 -> 提取角色基础事实 -> 先锁定性别 -> 再判断时代/朝代/世界观 -> 再判断身份阶层职业 -> 再选择五官、发型、服装、配饰 -> 执行道具过滤 -> 输出角色资产表。',
  '性别规则：男性角色不得调用女性服装、凤冠、步摇、霞帔、襦裙、宫裙、女帝高髻等女性专属规则；女性角色不得调用男性冠帽、蟒袍、衮服、权臣朝服、男性朝靴等男性专属规则；性别不明时使用中性保守描述并标注“剧本未明确”。',
  '时代规则：现代角色只能使用现代服装、发型和材质；古代角色只能使用古代服装系统；不得把现代服装混入古代角色，也不得把古装词库混入现代角色。',
  '高位古装规则：高位男性强化金冠/玉冠/翼善冠、圆领袍/蟒袍/衮服/朝服、宽阔袍摆、袍摆压地、长袍遮鞋、不露鞋面不露脚踝；高位女性强化凤冠/珠翠头面/大体量盘发、重工大袖礼袍、厚重曳地宫裙、层层堆叠裙摆、裙摆遮鞋、不露鞋面不露脚踝。',
  '道具过滤规则：剧本中的武器、手机、文件、扇子、伞、佩剑、佩刀、香囊、玉佩、令牌、腰间流苏、腰间挂件等只能进入“配饰与道具档案”，不得进入最终生图提示词。双手必须空握不持物，腰间不挂载悬挂物。',
  '固定生图构图：真人写实风格，模拟真实拍摄效果，8K 超高清，明亮柔和光线，干净白色背景。左侧正面面部特写，右侧正好 3 个全身人物单行水平排列，分别为正面、右侧面 90 度、背面；全图正好 4 个人物形象，不多不少，同一人同一服装同一发型。',
  '每个角色输出字段必须包含：基础设定、身材体态、脸部特征、发型、服装配色、内衬层、中间层、外层/外袍、下装、鞋子设定、面料质感、图案纹样、纹样位置、结构廓形、工艺重工程度、穿着状态、配饰与道具档案、最终生图提示词、负面提示词。',
  '最终输出用 Markdown。先给“角色总览表”，再逐个角色输出完整资产卡。信息不足时可以基于剧情合理推断，但必须标注“推断”，不得违背剧本。'
].join('\n');

const DEFAULT_TEXT_GENERATION_SYSTEM_PROMPT = [
  '你是专业中文创作助手。',
  '请严格按照用户输入的任务直接产出最终内容，不要把用户需求改写成提示词，不要输出“可用于生成的提示词”。',
  '如果用户要求写小说、文案、剧本、分镜、设定或分析，就直接写对应成品内容。',
  '除非用户明确要求解释过程，否则不要额外说明你将如何完成任务。'
].join('\n');

const DEFAULT_MIMO_BASE_URL = 'https://api.xiaomimimo.com/v1';
const DEFAULT_MIMO_TOKEN_PLAN_BASE_URL = 'https://token-plan-cn.xiaomimimo.com/v1';

const resolveMimoBaseUrl = (apiKey, env) => {
  const configuredBaseUrl = env.MIMO_BASE_URL || env.TEXT_BASE_URL || '';
  const isTokenPlanKey = String(apiKey || '').trim().startsWith('tp-');
  if (isTokenPlanKey && (!configuredBaseUrl || configuredBaseUrl.includes('api.xiaomimimo.com'))) {
    return DEFAULT_MIMO_TOKEN_PLAN_BASE_URL;
  }
  return configuredBaseUrl || DEFAULT_MIMO_BASE_URL;
};

const normalizeInputMedia = (inputMedia = []) => inputMedia
  .filter(item => item?.url && (item.type === 'image' || item.type === 'video'))
  .slice(0, 6)
  .map(item => {
    if (item.type === 'video') {
      return {
        type: 'video_url',
        video_url: { url: item.url },
        fps: Number(item.fps || 2),
        media_resolution: item.mediaResolution || 'default',
      };
    }
    return {
      type: 'image_url',
      image_url: { url: item.url },
    };
  });

const resolveMimoTextModel = (modelName, env) => {
  const value = String(modelName || '').toLowerCase();
  if (value.includes('2.5 pro') || value.includes('2.5-pro') || value.includes('2.5pro')) return 'mimo-v2.5-pro';
  if (value.includes('2.5')) return 'mimo-v2.5';
  return env.MIMO_TEXT_MODEL_ID || env.TEXT_MODEL_ID || 'mimo-v2.5-pro';
};

const buildMimoPayload = (body, env) => {
  const task = body.task || 'text';
  const baseMessages = [];
  let model = resolveMimoTextModel(body.modelName, env);
  let maxCompletionTokens = Number(env.MIMO_MAX_COMPLETION_TOKENS || 4096);

  if (task === 'media-analysis') {
    const mediaParts = normalizeInputMedia(body.inputMedia || body.media || []);
    if (!mediaParts.length) throw new Error('INPUT_MEDIA_REQUIRED');
    model = env.MIMO_VISION_MODEL_ID || 'mimo-v2.5';
    maxCompletionTokens = Number(env.MIMO_MEDIA_MAX_COMPLETION_TOKENS || 4096);
    baseMessages.push({ role: 'system', content: env.MIMO_MEDIA_SYSTEM_PROMPT || MEDIA_ANALYSIS_SYSTEM_PROMPT });
    baseMessages.push({
      role: 'user',
      content: [
        ...mediaParts,
        {
          type: 'text',
          text: [
            body.prompt ? `用户补充要求：${body.prompt}` : '',
            '请根据输入媒体输出分析结果。图片输出“画面构成分析 + 复刻提示词”；视频输出“完整分镜表 + 视频复刻提示词”。'
          ].filter(Boolean).join('\n'),
        },
      ],
    });
  } else if (task === 'script-assets') {
    baseMessages.push({ role: 'system', content: env.MIMO_SCRIPT_SYSTEM_PROMPT || DEFAULT_SCRIPT_ASSET_SYSTEM_PROMPT });
    baseMessages.push({ role: 'user', content: body.prompt || '' });
  } else {
    baseMessages.push({ role: 'system', content: env.MIMO_TEXT_SYSTEM_PROMPT || DEFAULT_TEXT_GENERATION_SYSTEM_PROMPT });
    baseMessages.push({ role: 'user', content: body.prompt || '' });
  }

  return {
    model,
    messages: baseMessages,
    max_completion_tokens: maxCompletionTokens,
    temperature: Number(env.MIMO_TEMPERATURE || 0.7),
    top_p: Number(env.MIMO_TOP_P || 0.95),
    stream: false,
    thinking: { type: 'disabled' },
  };
};

const handleLogin = async (request, env) => {
  if (request.method !== 'POST') return json({ error: 'METHOD_NOT_ALLOWED' }, 405);
  const body = await request.json().catch(() => ({}));
  if (body.password !== (env.LOGIN_PASSWORD || 'kc8888')) {
    return json({ error: 'INVALID_PASSWORD' }, 401);
  }
  return json({ token: await createToken(env) });
};

const handleMe = async (request, env) => {
  if (!(await requireAuth(request, env))) return json({ error: 'UNAUTHORIZED' }, 401);
  return json({ ok: true });
};

const handleImageGeneration = async (request, env) => {
  if (request.method !== 'POST') return json({ error: 'METHOD_NOT_ALLOWED' }, 405);
  if (!(await requireAuth(request, env))) return json({ error: 'UNAUTHORIZED' }, 401);

  const body = await request.json().catch(() => ({}));
  const count = Math.max(1, Math.min(Number(body.count || 1), 4));
  const payload = {
    model: env.SEEDREAM_MODEL_ID || 'doubao-seedream-5-0-260128',
    prompt: body.prompt || '',
    sequential_image_generation: 'disabled',
    response_format: 'url',
    size: env.SEEDREAM_SIZE || seedreamSize(body.resolution),
    stream: false,
    watermark: env.SEEDREAM_WATERMARK !== 'false',
  };
  if (body.inputImages?.length) {
    payload.image = body.inputImages[0];
    payload.image_url = body.inputImages[0];
    payload.reference_image = body.inputImages[0];
  }

  const results = [];
  for (let index = 0; index < count; index += 1) {
    const result = await callModelApi({
      baseUrl: env.SEEDREAM_BASE_URL,
      endpoint: env.SEEDREAM_IMAGE_ENDPOINT || '/images/generations',
      apiKey: env.SEEDREAM_API_KEY,
      payload,
    });
    results.push(...extractUrls(result));
  }

  const urls = [...new Set(results)];
  if (!urls.length) throw new Error('NO_IMAGE_URL_RETURNED');
  return json({ urls });
};

const handleMultiAngleGeneration = async (request, env) => {
  if (request.method !== 'POST') return json({ error: 'METHOD_NOT_ALLOWED' }, 405);
  if (!(await requireAuth(request, env))) return json({ error: 'UNAUTHORIZED' }, 401);

  const body = await request.json().catch(() => ({}));
  if (!body.image) return json({ error: 'IMAGE_REQUIRED' }, 400);
  const angles = Array.isArray(body.angles) && body.angles.length ? body.angles.slice(0, 8) : ['left_45', 'right_45', 'back'];
  const countPerAngle = Math.max(1, Math.min(Number(body.countPerAngle || 1), 2));
  const size = aspectToQwenSize(body.aspectRatio);

  const results = [];
  for (const angle of angles) {
    const prompt = buildMultiAnglePrompt({
      angle,
      prompt: body.prompt,
      consistency: body.consistency,
      background: body.background,
      yaw: Number(body.yaw || 0),
      pitch: Number(body.pitch || 0),
      zoom: body.zoom,
      targetMode: body.targetMode || 'scene',
    });
    const parameters = {
      n: countPerAngle,
      negative_prompt: body.negativePrompt || '低清晰度，变形，主体结构错误，多余肢体，文字错误，拼贴，多宫格',
      watermark: env.QWEN_EDIT_WATERMARK === 'true',
      result_format: 'message',
    };
    if (size) parameters.size = size;

    const result = await callModelApi({
      baseUrl: env.QWEN_EDIT_BASE_URL || 'https://dashscope.aliyuncs.com/api/v1',
      endpoint: env.QWEN_EDIT_ENDPOINT || '/services/aigc/multimodal-generation/generation',
      apiKey: getQwenEditApiKey(env),
      payload: {
        model: env.QWEN_EDIT_MODEL || 'qwen-image-edit-plus-2025-12-15',
        input: {
          messages: [{
            role: 'user',
            content: [
              { image: body.image },
              { text: prompt },
            ],
          }],
        },
        parameters,
      },
      timeoutMs: 600000,
    });

    for (const url of extractUrls(result)) {
      results.push({
        angle,
        label: angleLabels[angle] || angle,
        url,
        prompt,
      });
    }
  }

  if (!results.length) throw new Error('NO_MULTI_ANGLE_URL_RETURNED');
  return json({ results });
};

const handleTextGeneration = async (request, env) => {
  if (request.method !== 'POST') return json({ error: 'METHOD_NOT_ALLOWED' }, 405);
  if (!(await requireAuth(request, env))) return json({ error: 'UNAUTHORIZED' }, 401);
  const body = await request.json().catch(() => ({}));
  const apiKey = env.MIMO_API_KEY || env.TEXT_API_KEY;
  const baseUrl = resolveMimoBaseUrl(apiKey, env);
  const endpoint = env.MIMO_TEXT_ENDPOINT || env.TEXT_ENDPOINT || '/chat/completions';
  if (!apiKey) {
    return json({ text: body.prompt || '', mock: true });
  }
  const result = await callTextModelApi({
    baseUrl,
    endpoint,
    apiKey,
    payload: buildMimoPayload(body, env),
    timeoutMs: 600000,
  });
  return json({ text: extractText(result), usage: result.usage || null });
};

const handleDirectorLayoutGeneration = async (request, env) => {
  if (request.method !== 'POST') return json({ error: 'METHOD_NOT_ALLOWED' }, 405);
  if (!(await requireAuth(request, env))) return json({ error: 'UNAUTHORIZED' }, 401);
  const body = await request.json().catch(() => ({}));
  const imageUrl = typeof body?.image?.url === 'string' ? body.image.url.trim() : '';
  if (!imageUrl || !(imageUrl.startsWith('data:image/') || imageUrl.startsWith('http://') || imageUrl.startsWith('https://'))) {
    return json({ error: 'DIRECTOR_LAYOUT_IMAGE_REQUIRED' }, 400);
  }

  const apiKey = env.DIRECTOR_LAYOUT_MODEL_DISABLED === 'true'
    ? ''
    : env.DIRECTOR_LAYOUT_API_KEY || env.MIMO_API_KEY || env.TEXT_API_KEY;
  if (!apiKey) return json({ error: 'DIRECTOR_LAYOUT_MODEL_NOT_CONFIGURED' }, 501);
  const baseUrl = env.DIRECTOR_LAYOUT_BASE_URL || resolveMimoBaseUrl(apiKey, env);
  const endpoint = env.DIRECTOR_LAYOUT_ENDPOINT || env.MIMO_TEXT_ENDPOINT || env.TEXT_ENDPOINT || '/chat/completions';
  const model = env.DIRECTOR_LAYOUT_MODEL_ID || env.MIMO_VISION_MODEL_ID || resolveMimoTextModel('2.5', env);
  let previousText = '';
  let previousIssues = [];

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const correction = attempt === 1
      ? [
          '上一次输出未通过校验。请只修正 JSON 后重新完整输出，必须同时包含 components 与 characters 两个字段。',
          `校验错误：${previousIssues.join('；')}`,
          `上一次输出：${previousText.slice(0, 12000)}`,
        ].join('\n')
      : '分析这张参考图，同时输出粗布景组件与人物占位的 JSON。';
    const result = await callModelApi({
      baseUrl,
      endpoint,
      apiKey,
      payload: {
        model,
        messages: [
          { role: 'system', content: env.DIRECTOR_LAYOUT_SYSTEM_PROMPT || env.MIMO_DIRECTOR_LAYOUT_SYSTEM_PROMPT || DIRECTOR_LAYOUT_SYSTEM_PROMPT },
          {
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: imageUrl } },
              { type: 'text', text: correction },
            ],
          },
        ],
        max_completion_tokens: Number(env.DIRECTOR_LAYOUT_MAX_COMPLETION_TOKENS || env.MIMO_DIRECTOR_LAYOUT_MAX_COMPLETION_TOKENS || 6144),
        temperature: 0.1,
        top_p: 0.9,
        stream: false,
        thinking: { type: 'disabled' },
      },
      timeoutMs: 180000,
    });
    previousText = extractText(result);
    try {
      const draft = validateDirectorLayoutCandidate(parseDirectorLayoutJson(previousText));
      return json({ draft, usage: result.usage || null });
    } catch (error) {
      previousIssues = Array.isArray(error?.issues) ? error.issues.slice(0, 12) : [error?.message || '布局 JSON 无效'];
    }
  }

  return json({
    error: 'DIRECTOR_LAYOUT_INVALID_MODEL_JSON',
    message: '视觉模型两次返回的数据都不符合布局格式',
    issues: previousIssues,
  }, 502);
};

const handleAudioGeneration = async (request, env) => {
  if (request.method !== 'POST') return json({ error: 'METHOD_NOT_ALLOWED' }, 405);
  if (!(await requireAuth(request, env))) return json({ error: 'UNAUTHORIZED' }, 401);
  const body = await request.json().catch(() => ({}));
  const text = String(body.text || body.prompt || '').trim();
  if (!text) return json({ error: 'TEXT_REQUIRED' }, 400);
  const apiKey = env.MINIMAX_TTS_API_KEY || env.MINIMAX_API_KEY || env.AUDIO_API_KEY;
  if (!apiKey) {
    return json({ urls: [mockAudio({ text })], mock: true });
  }
  const result = await callModelApi({
    baseUrl: env.MINIMAX_TTS_BASE_URL || env.MINIMAX_BASE_URL || env.AUDIO_BASE_URL || 'https://api.minimax.io',
    endpoint: getMinimaxTtsEndpoint(env),
    apiKey,
    payload: buildMinimaxSpeechPayload({ ...body, text }, env),
    timeoutMs: 600000,
  });
  const urls = extractAudioUrls(result);
  if (!urls.length) throw new Error('NO_AUDIO_RETURNED');
  return json({ urls });
};

// --- Agnes Video V2.0 (async task-based video generation) ---
// Docs: https://agnes-ai.com/doc/agnes-video-v20
// Flow: POST /v1/videos -> { id } ; then poll GET /v1/videos/{id} until status === 'completed'.
const AGNES_MAX_FRAMES = 441;
const AGNES_RESOLUTION_SHORT_EDGE = {
  '360p': 360, '480p': 480, '540p': 540, '576p': 576,
  '720p': 720, '1080p': 1080, '1440p': 1440, '2160p': 2160,
};

const roundToMultipleOf8 = (value) => Math.max(8, Math.round(value / 8) * 8);

// num_frames must be <= 441 and follow the 8n + 1 pattern (e.g. 81, 121, 241, 441).
const snapAgnesFrames = (frames) => {
  const n = Math.max(1, Math.round((Number(frames) - 1) / 8));
  return Math.min(AGNES_MAX_FRAMES, n * 8 + 1);
};

const parseDurationSeconds = (duration) => {
  const seconds = parseFloat(String(duration ?? '').replace(/[^0-9.]/g, ''));
  return Number.isFinite(seconds) && seconds > 0 ? seconds : 5;
};

// "720p" is the short edge of the frame; derive width/height from the aspect ratio.
const agnesDimensions = (aspectRatio, resolution) => {
  const [wRaw, hRaw] = String(aspectRatio || '16:9').split(':').map(Number);
  const widthRatio = Number.isFinite(wRaw) && wRaw > 0 ? wRaw : 16;
  const heightRatio = Number.isFinite(hRaw) && hRaw > 0 ? hRaw : 9;
  const shortEdge = AGNES_RESOLUTION_SHORT_EDGE[String(resolution || '').toLowerCase()] || 720;
  if (widthRatio >= heightRatio) {
    return { width: roundToMultipleOf8(shortEdge * widthRatio / heightRatio), height: roundToMultipleOf8(shortEdge) };
  }
  return { width: roundToMultipleOf8(shortEdge), height: roundToMultipleOf8(shortEdge * heightRatio / widthRatio) };
};

const buildAgnesVideoPayload = (body, env) => {
  const frameRate = Math.max(1, Math.min(Number(env.AGNES_VIDEO_FPS) || 24, 60));
  const numFrames = snapAgnesFrames(parseDurationSeconds(body.duration) * frameRate);
  const { width, height } = agnesDimensions(body.aspectRatio, body.resolution);
  const images = Array.isArray(body.inputImages) ? body.inputImages.filter(Boolean) : [];
  // Agnes fetches input images by URL — they must be public http(s) links, not base64/blob.
  const nonPublicImage = images.find((url) => !/^https?:\/\//i.test(url));
  if (nonPublicImage) {
    throw new Error('AGNES_VIDEO_IMAGE_NOT_PUBLIC_URL: 图生视频/首尾帧需要公网图片链接(http/https)。当前连接的是本地图片或 base64，Agnes 无法读取。请改用模型在线生成的图片，或先把图片上传到公网再连。');
  }
  const prompt = (body.prompt && body.prompt.trim())
    || env.AGNES_VIDEO_DEFAULT_PROMPT
    || 'Cinematic natural motion with smooth camera movement.';

  const payload = {
    model: env.AGNES_VIDEO_MODEL_ID || 'agnes-video-v2.0',
    prompt,
    width,
    height,
    num_frames: numFrames,
    frame_rate: frameRate,
  };

  const inferenceSteps = Number(env.AGNES_VIDEO_INFERENCE_STEPS);
  if (Number.isFinite(inferenceSteps) && inferenceSteps > 0) payload.num_inference_steps = inferenceSteps;
  if (env.AGNES_VIDEO_NEGATIVE_PROMPT) payload.negative_prompt = env.AGNES_VIDEO_NEGATIVE_PROMPT;

  if (body.isStartEndMode && images.length >= 2) {
    // Keyframe animation: interpolate between the first and last frame.
    payload.extra_body = { image: images.slice(0, 2), mode: 'keyframes' };
  } else if (images.length >= 2) {
    // Multi-image guided generation.
    payload.extra_body = { image: images };
  } else if (images.length === 1) {
    // Single image-to-video.
    payload.image = images[0];
  }

  return payload;
};

const agnesRequest = async ({ url, apiKey, method = 'GET', payload, timeoutMs = 60000 }) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...(payload ? { 'Content-Type': 'application/json' } : {}),
      },
      body: payload ? JSON.stringify(payload) : undefined,
      signal: controller.signal,
    });
    const text = await response.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
    if (!response.ok) {
      const error = new Error(data?.error?.message || data?.message || data?.raw || `AGNES_VIDEO_${response.status}`);
      error.statusCode = response.status;
      throw error;
    }
    return data;
  } catch (error) {
    // Turn the opaque AbortError into an actionable message.
    if (error?.name === 'AbortError' || controller.signal.aborted) {
      throw new Error(`AGNES_VIDEO_REQUEST_TIMEOUT (单次请求超过 ${Math.round(timeoutMs / 1000)}s，可能是网络慢或输入图片过大)`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
};

// --- Volcengine Ark Seedance (doubao-seedance) — async task-based video generation ---
// Create: POST /api/v3/contents/generations/tasks -> { id }
// Poll:   GET  /api/v3/contents/generations/tasks/{id} -> { status, content: { video_url } }
// Parameters are passed as text flags inside content[0].text (e.g. "--duration 5 --ratio 16:9").
const SEEDANCE_DEFAULT_BASE = 'https://ark.cn-beijing.volces.com';
const SEEDANCE_DEFAULT_ENDPOINT = '/api/v3/contents/generations/tasks';

const buildSeedancePayload = (body, env) => {
  const images = Array.isArray(body.inputImages) ? body.inputImages.filter(Boolean) : [];
  const duration = Math.round(parseDurationSeconds(body.duration));
  const watermark = env.SEEDANCE_WATERMARK === 'true';

  const flags = [
    `--resolution ${String(body.resolution || '720p')}`,
    `--duration ${duration}`,
    `--watermark ${watermark}`,
    '--camerafixed false',
  ];
  // For image-to-video the ratio is derived from the input image; only force --ratio for text-to-video.
  if (images.length === 0) flags.push(`--ratio ${String(body.aspectRatio || '16:9')}`);

  const prompt = (body.prompt && body.prompt.trim()) || env.SEEDANCE_DEFAULT_PROMPT || '';
  const content = [{ type: 'text', text: `${prompt} ${flags.join(' ')}`.trim() }];

  if (body.isStartEndMode && images.length >= 2) {
    content.push({ role: 'first_frame', type: 'image_url', image_url: { url: images[0] } });
    content.push({ role: 'last_frame', type: 'image_url', image_url: { url: images[images.length - 1] } });
  } else {
    for (const url of images) content.push({ type: 'image_url', image_url: { url } });
  }

  return { model: env.SEEDANCE_MODEL_ID || 'doubao-seedance-1-5-pro-251215', content };
};

// Create a single Seedance task. Returns { taskId, videoUrl? } — does NOT poll.
const createSeedanceTask = async (body, env) => {
  const apiKey = env.SEEDANCE_API_KEY;
  const baseUrl = (env.SEEDANCE_BASE_URL || SEEDANCE_DEFAULT_BASE).replace(/\/$/, '');
  const createEndpoint = env.SEEDANCE_CREATE_ENDPOINT || env.SEEDANCE_VIDEO_ENDPOINT || SEEDANCE_DEFAULT_ENDPOINT;
  const createTimeoutMs = Number(env.SEEDANCE_CREATE_TIMEOUT_MS) || 120000;

  const created = await agnesRequest({
    url: joinUrl(baseUrl, createEndpoint),
    apiKey,
    method: 'POST',
    payload: buildSeedancePayload(body, env),
    timeoutMs: createTimeoutMs,
  });

  const taskId = created.id || created?.data?.id;
  if (!taskId) throw new Error('SEEDANCE_VIDEO_NO_TASK_ID');
  if (String(created.status).toLowerCase() === 'failed') {
    throw new Error(created?.error?.message || 'SEEDANCE_VIDEO_TASK_FAILED');
  }
  return { taskId, videoUrl: created?.content?.video_url || null };
};

// Create a single Agnes task. Returns { taskId, videoUrl? } — does NOT poll.
// Polling is done by the browser (no Cloudflare Workers 30s wall-clock limit there).
const createAgnesTask = async (body, env) => {
  const apiKey = env.AGNES_VIDEO_API_KEY;
  const baseUrl = (env.AGNES_VIDEO_BASE_URL || 'https://apihub.agnes-ai.com').replace(/\/$/, '');
  const createEndpoint = env.AGNES_VIDEO_CREATE_ENDPOINT || '/v1/videos';
  const createTimeoutMs = Number(env.AGNES_VIDEO_CREATE_TIMEOUT_MS) || 120000;

  const created = await agnesRequest({
    url: joinUrl(baseUrl, createEndpoint),
    apiKey,
    method: 'POST',
    payload: buildAgnesVideoPayload(body, env),
    timeoutMs: createTimeoutMs,
  });

  const taskId = created.id || created.task_id || created?.data?.id;
  if (!taskId) throw new Error('AGNES_VIDEO_NO_TASK_ID');
  if (String(created.status).toLowerCase() === 'failed') {
    throw new Error(created?.error?.message || 'AGNES_VIDEO_TASK_FAILED');
  }
  const videoUrl = String(created.status).toLowerCase() === 'completed' ? (created.video_url || created.remixed_from_video_id || null) : null;
  return { taskId, videoUrl };
};

// POST /api/generate/video — create task(s), return { taskIds } immediately.
// The browser then polls /api/generate/video/poll?taskId=... until completed.
const handleVideoCreate = async (request, env) => {
  if (request.method !== 'POST') return json({ error: 'METHOD_NOT_ALLOWED' }, 405);
  if (!(await requireAuth(request, env))) return json({ error: 'UNAUTHORIZED' }, 401);

  const body = await request.json().catch(() => ({}));
  const count = Math.max(1, Math.min(Number(body.count) || 1, 4));

  // Primary provider: Volcengine Ark Seedance (doubao-seedance).
  if (env.SEEDANCE_API_KEY) {
    const tasks = await Promise.all(Array.from({ length: count }, () => createSeedanceTask(body, env)));
    if (tasks.every((t) => t.videoUrl)) return json({ urls: tasks.map((t) => t.videoUrl) });
    return json({ taskIds: tasks.map((t) => t.taskId), provider: 'seedance' });
  }

  // Fallback provider: Agnes Video V2.0.
  if (env.AGNES_VIDEO_API_KEY) {
    const tasks = await Promise.all(Array.from({ length: count }, () => createAgnesTask(body, env)));
    if (tasks.every((t) => t.videoUrl)) return json({ urls: tasks.map((t) => t.videoUrl) });
    return json({ taskIds: tasks.map((t) => t.taskId), provider: 'agnes' });
  }

  return json({ error: 'VIDEO_API_NOT_CONFIGURED' }, 501);
};

// GET /api/generate/video/poll?taskId=xxx — single Agnes status check, called by the browser.
const handleVideoPoll = async (request, env) => {
  if (request.method !== 'GET') return json({ error: 'METHOD_NOT_ALLOWED' }, 405);
  if (!(await requireAuth(request, env))) return json({ error: 'UNAUTHORIZED' }, 401);

  const { searchParams } = new URL(request.url);
  const taskId = searchParams.get('taskId');
  if (!taskId) return json({ error: 'TASK_ID_REQUIRED' }, 400);

  // Primary provider: Volcengine Ark Seedance. Must match the provider used by handleVideoCreate.
  if (env.SEEDANCE_API_KEY) {
    const baseUrl = (env.SEEDANCE_BASE_URL || SEEDANCE_DEFAULT_BASE).replace(/\/$/, '');
    const queryEndpoint = env.SEEDANCE_QUERY_ENDPOINT || env.SEEDANCE_CREATE_ENDPOINT || env.SEEDANCE_VIDEO_ENDPOINT || SEEDANCE_DEFAULT_ENDPOINT;
    const result = await agnesRequest({
      url: joinUrl(baseUrl, `${queryEndpoint}/${encodeURIComponent(taskId)}`),
      apiKey: env.SEEDANCE_API_KEY,
      timeoutMs: 20000,
    });
    return json(result);
  }

  // Fallback provider: Agnes Video V2.0.
  if (env.AGNES_VIDEO_API_KEY) {
    const baseUrl = (env.AGNES_VIDEO_BASE_URL || 'https://apihub.agnes-ai.com').replace(/\/$/, '');
    const queryEndpoint = env.AGNES_VIDEO_QUERY_ENDPOINT || '/v1/videos';
    const result = await agnesRequest({
      url: joinUrl(baseUrl, `${queryEndpoint}/${encodeURIComponent(taskId)}`),
      apiKey: env.AGNES_VIDEO_API_KEY,
      timeoutMs: 20000,
    });
    return json(result);
  }

  return json({ error: 'VIDEO_API_NOT_CONFIGURED' }, 501);
};

const handleHealth = async (request, env) => {
  if (!(await requireAuth(request, env))) return json({ error: 'UNAUTHORIZED' }, 401);
  const mimoApiKey = env.MIMO_API_KEY || env.TEXT_API_KEY;
  return json({
    ok: true,
    seedream: {
      hasBaseUrl: Boolean(env.SEEDREAM_BASE_URL),
      hasApiKey: Boolean(env.SEEDREAM_API_KEY),
      modelId: env.SEEDREAM_MODEL_ID || '',
      endpoint: env.SEEDREAM_IMAGE_ENDPOINT || '/images/generations',
      size: env.SEEDREAM_SIZE || '2K',
      watermark: env.SEEDREAM_WATERMARK !== 'false',
    },
    qwenEdit: {
      hasApiKey: Boolean(getQwenEditApiKey(env)),
      modelId: env.QWEN_EDIT_MODEL || 'qwen-image-edit-plus-2025-12-15',
      endpoint: `${env.QWEN_EDIT_BASE_URL || 'https://dashscope.aliyuncs.com/api/v1'}${env.QWEN_EDIT_ENDPOINT || '/services/aigc/multimodal-generation/generation'}`,
      watermark: env.QWEN_EDIT_WATERMARK === 'true',
    },
    mimo: {
      hasApiKey: Boolean(mimoApiKey),
      textModelId: env.MIMO_TEXT_MODEL_ID || env.TEXT_MODEL_ID || 'mimo-v2.5-pro',
      visionModelId: env.MIMO_VISION_MODEL_ID || 'mimo-v2.5',
      endpoint: `${resolveMimoBaseUrl(mimoApiKey, env)}${env.MIMO_TEXT_ENDPOINT || env.TEXT_ENDPOINT || '/chat/completions'}`,
    },
    minimaxAudio: {
      hasApiKey: Boolean(env.MINIMAX_TTS_API_KEY || env.MINIMAX_API_KEY || env.AUDIO_API_KEY),
      modelId: env.MINIMAX_TTS_MODEL_ID || env.AUDIO_MODEL_ID || 'speech-2.8-hd',
      endpoint: `${env.MINIMAX_TTS_BASE_URL || env.MINIMAX_BASE_URL || env.AUDIO_BASE_URL || 'https://api.minimax.io'}${getMinimaxTtsEndpoint(env)}`,
    },
    seedanceVideo: {
      hasApiKey: Boolean(env.SEEDANCE_API_KEY),
      modelId: env.SEEDANCE_MODEL_ID || 'doubao-seedance-1-5-pro-251215',
      endpoint: `${(env.SEEDANCE_BASE_URL || SEEDANCE_DEFAULT_BASE).replace(/\/$/, '')}${env.SEEDANCE_CREATE_ENDPOINT || env.SEEDANCE_VIDEO_ENDPOINT || SEEDANCE_DEFAULT_ENDPOINT}`,
    },
    agnesVideo: {
      hasApiKey: Boolean(env.AGNES_VIDEO_API_KEY),
      modelId: env.AGNES_VIDEO_MODEL_ID || 'agnes-video-v2.0',
      endpoint: `${(env.AGNES_VIDEO_BASE_URL || 'https://apihub.agnes-ai.com').replace(/\/$/, '')}${env.AGNES_VIDEO_CREATE_ENDPOINT || '/v1/videos'}`,
      fps: Number(env.AGNES_VIDEO_FPS) || 24,
    },
    // Active video provider (Seedance takes priority over Agnes when configured).
    videoProvider: env.SEEDANCE_API_KEY ? 'seedance' : (env.AGNES_VIDEO_API_KEY ? 'agnes' : 'none'),
  });
};

export async function onRequest(context) {
  const { request, env } = context;
  const { pathname } = new URL(request.url);

  try {
    if (pathname === '/api/auth/login') return await handleLogin(request, env);
    if (pathname === '/api/auth/me') return await handleMe(request, env);
    if (pathname === '/api/media/upload') return await handleMediaUpload(request, env);
    if (pathname.startsWith('/api/media/')) return await handleMediaGet(request, env, pathname);
    if (pathname === '/api/generate/image') return await handleImageGeneration(request, env);
    if (pathname === '/api/generate/multi-angle') return await handleMultiAngleGeneration(request, env);
    if (pathname === '/api/generate/text') return await handleTextGeneration(request, env);
    if (pathname === '/api/director-layout') return await handleDirectorLayoutGeneration(request, env);
    if (pathname === '/api/generate/audio') return await handleAudioGeneration(request, env);
    if (pathname === '/api/generate/video') return await handleVideoCreate(request, env);
    if (pathname === '/api/generate/video/poll') return await handleVideoPoll(request, env);
    if (pathname === '/api/health') return await handleHealth(request, env);
    return json({ error: 'NOT_FOUND' }, 404);
  } catch (error) {
    console.error(error);
    return json({ error: error.message || 'SERVER_ERROR' }, error.statusCode || 500);
  }
}
