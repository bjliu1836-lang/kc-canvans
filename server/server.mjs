import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const distDir = path.join(rootDir, 'dist');
const tempMediaDir = path.join(rootDir, '.tmp-media');

const loadDotEnv = () => {
  const envPath = path.join(rootDir, '.env');
  if (!fs.existsSync(envPath)) return;

  const content = fs.readFileSync(envPath, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (!process.env[key]) process.env[key] = value;
  }
};

loadDotEnv();

const PORT = Number(process.env.PORT || 8787);
const LOGIN_PASSWORD = process.env.LOGIN_PASSWORD || 'kc8888';
const AUTH_SECRET = process.env.AUTH_SECRET || 'kc-canvas-dev-secret-change-me';
const TOKEN_TTL_SECONDS = Number(process.env.AUTH_TOKEN_TTL_SECONDS || 60 * 60 * 24 * 7);

const json = (res, status, data) => {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(data));
};

const readBody = async (req) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
};

const base64url = (value) => Buffer.from(value).toString('base64url');
const sign = (payload) => crypto.createHmac('sha256', AUTH_SECRET).update(payload).digest('base64url');

const createToken = () => {
  const payload = base64url(JSON.stringify({
    sub: 'kc-user',
    exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS,
  }));
  return `${payload}.${sign(payload)}`;
};

const verifyToken = (token) => {
  try {
    if (!token || !token.includes('.')) return false;
    const [payload, signature] = token.split('.');
    const expected = sign(payload);
    const signatureBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expected);
    if (signatureBuffer.length !== expectedBuffer.length) return false;
    if (!crypto.timingSafeEqual(signatureBuffer, expectedBuffer)) return false;

    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return data.exp > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
};

const requireAuth = (req, res) => {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (verifyToken(token)) return true;
  json(res, 401, { error: 'UNAUTHORIZED' });
  return false;
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
  return { mimeType, buffer: Buffer.from(match[2].replace(/\s/g, ''), 'base64') };
};

const publicOrigin = (req) => {
  return (process.env.MEDIA_PUBLIC_BASE_URL || `http://${req.headers.host}`).replace(/\/$/, '');
};

const handleMediaUpload = async (req, res) => {
  const body = await readBody(req);
  const { mimeType, buffer } = parseImageDataUrl(body.dataUrl);
  const maxBytes = Number(process.env.MEDIA_UPLOAD_MAX_BYTES) || 12 * 1024 * 1024;
  if (buffer.byteLength > maxBytes) return json(res, 413, { error: 'MEDIA_UPLOAD_TOO_LARGE' });

  fs.mkdirSync(path.join(tempMediaDir, 'temp'), { recursive: true });
  const key = `temp/${crypto.randomUUID()}.${mediaExtension(mimeType)}`;
  fs.writeFileSync(path.join(tempMediaDir, key), buffer);
  return json(res, 200, { url: `${publicOrigin(req)}/api/media/${key}`, key });
};

const handleMediaGet = (req, res, pathname) => {
  const key = decodeURIComponent(pathname.replace('/api/media/', ''));
  if (!key || key.includes('..')) return json(res, 404, { error: 'MEDIA_NOT_FOUND' });
  const filePath = path.join(tempMediaDir, key);
  if (!filePath.startsWith(tempMediaDir) || !fs.existsSync(filePath)) {
    return json(res, 404, { error: 'MEDIA_NOT_FOUND' });
  }
  const ext = path.extname(filePath).toLowerCase();
  const contentType = ext === '.jpg' || ext === '.jpeg'
    ? 'image/jpeg'
    : ext === '.png'
      ? 'image/png'
      : ext === '.webp'
        ? 'image/webp'
        : 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'public, max-age=86400' });
  fs.createReadStream(filePath).pipe(res);
};

const imageSize = (aspectRatio = '1:1', resolution = '1k') => {
  const [wRaw, hRaw] = aspectRatio.split(':').map(Number);
  const w = Number.isFinite(wRaw) && wRaw > 0 ? wRaw : 1;
  const h = Number.isFinite(hRaw) && hRaw > 0 ? hRaw : 1;
  let width = 1024;
  let height = 1024;
  if (w >= h) {
    width = 1024;
    height = Math.round(1024 * h / w);
  } else {
    height = 1024;
    width = Math.round(1024 * w / h);
  }
  if (resolution === '2k') {
    width *= 2;
    height *= 2;
  } else if (resolution === '4k') {
    width *= 4;
    height *= 4;
  }
  return `${width}x${height}`;
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

const mockImage = ({ prompt = '', aspectRatio = '1:1', resolution = '1k', index = 0 }) => {
  const [width, height] = imageSize(aspectRatio, resolution).split('x').map(Number);
  const safePrompt = String(prompt || 'KC 影视分镜概念图')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  const hue = (safePrompt.length * 37 + index * 61) % 360;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
<defs><linearGradient id="g" x1="0" x2="1" y1="0" y2="1"><stop offset="0%" stop-color="hsl(${hue},70%,18%)"/><stop offset="100%" stop-color="hsl(${(hue + 120) % 360},65%,28%)"/></linearGradient></defs>
<rect width="100%" height="100%" fill="url(#g)"/><rect x="${width * 0.07}" y="${height * 0.08}" width="${width * 0.86}" height="${height * 0.84}" rx="24" fill="rgba(0,0,0,.24)" stroke="rgba(255,255,255,.22)"/>
<text x="${width * 0.12}" y="${height * 0.2}" fill="white" font-size="${Math.max(24, width / 26)}" font-family="Arial" font-weight="700">KC画布后端模拟生图</text>
<foreignObject x="${width * 0.12}" y="${height * 0.34}" width="${width * 0.76}" height="${height * 0.38}"><div xmlns="http://www.w3.org/1999/xhtml" style="font-family:Arial;color:white;font-size:${Math.max(18, width / 42)}px;line-height:1.35;font-weight:600;word-break:break-word;">${safePrompt}</div></foreignObject>
<text x="${width * 0.12}" y="${height * 0.84}" fill="rgba(255,255,255,.68)" font-size="${Math.max(12, width / 70)}" font-family="Arial">配置 SEEDREAM_API_KEY 后返回真实模型结果</text>
</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
};

const bytesToBase64 = (bytes) => Buffer.from(bytes).toString('base64');

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

const resolveMinimaxSpeechModel = (modelName) => {
  const value = String(modelName || '').toLowerCase();
  if (value.includes('2.8')) return 'speech-2.8-hd';
  return process.env.MINIMAX_TTS_MODEL_ID || process.env.AUDIO_MODEL_ID || 'speech-2.8-hd';
};

const getMinimaxTtsEndpoint = () => {
  const endpoint = process.env.MINIMAX_TTS_ENDPOINT || process.env.AUDIO_ENDPOINT || '/v1/t2a_v2';
  const groupId = process.env.MINIMAX_GROUP_ID || process.env.MINIMAX_TTS_GROUP_ID;
  if (!groupId || /[?&]GroupId=/.test(endpoint)) return endpoint;
  return `${endpoint}${endpoint.includes('?') ? '&' : '?'}GroupId=${encodeURIComponent(groupId)}`;
};

const buildMinimaxSpeechPayload = (body) => ({
  model: resolveMinimaxSpeechModel(body.modelName || body.model),
  text: String(body.text || body.prompt || '').slice(0, 50000),
  stream: false,
  voice_setting: {
    voice_id: body.voiceId || process.env.MINIMAX_TTS_VOICE_ID || 'male-qn-qingse',
    speed: Number(body.speed || 1),
    vol: Number(body.volume || 1),
    pitch: Number(body.pitch || 0),
  },
  audio_setting: {
    sample_rate: Number(process.env.MINIMAX_TTS_SAMPLE_RATE || 32000),
    bitrate: Number(process.env.MINIMAX_TTS_BITRATE || 128000),
    format: process.env.MINIMAX_TTS_FORMAT || 'mp3',
    channel: Number(process.env.MINIMAX_TTS_CHANNEL || 1),
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

const getQwenEditApiKey = () => (
  process.env.DASHSCOPE_API_KEY ||
  process.env.QWEN_EDIT_API_KEY ||
  process.env.ALIYUN_DASHSCOPE_API_KEY ||
  process.env.DASHSCOPE_KEY
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

const DIRECTOR_LAYOUT_SYSTEM_PROMPT = [
  '你是 3D 影视预演的室内粗布景分析器。',
  '只依据一张参考图估计可编辑的粗布景，不要虚构图中不可见的精细结构。',
  '只识别这些 category：ground, wall, door, window, table, chair, sofa, cabinet。',
  '只使用这些 primitive：box, cylinder。不要返回模型名、GLB、纹理或外部资产。',
  '坐标单位是米，Y 轴向上；position 是物体底面中心；size 顺序是宽、高、深，且每项必须大于 0。',
  '门洞附近的墙应拆成门洞左右或上方的墙段，不要用一整块墙堵住门洞。',
  '最多 30 个组件。无法确认的物体请降低 confidence 并设置 uncertain=true。',
  '没有已知尺寸时使用常见室内尺度估计，scale.mode 固定为 estimated。',
  '只输出一个 JSON 对象，不要 Markdown，不要解释。格式：',
  '{"scale":{"mode":"estimated","confidence":0.4},"components":[{"id":"wall_01","name":"后墙","category":"wall","primitive":"box","position":[0,0,-3],"size":[6,2.8,0.15],"rotationYDegrees":0,"confidence":0.8,"uncertain":false,"notes":""}]}'
].join('\n');

const DIRECTOR_LAYOUT_CATEGORIES = new Set(['ground', 'wall', 'door', 'window', 'table', 'chair', 'sofa', 'cabinet']);
const DIRECTOR_LAYOUT_PRIMITIVES = new Set(['box', 'cylinder']);

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

const resolveMimoBaseUrl = (apiKey) => {
  const configuredBaseUrl = process.env.MIMO_BASE_URL || process.env.TEXT_BASE_URL || '';
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

const resolveMimoTextModel = (modelName) => {
  const value = String(modelName || '').toLowerCase();
  if (value.includes('2.5 pro') || value.includes('2.5-pro') || value.includes('2.5pro')) return 'mimo-v2.5-pro';
  if (value.includes('2.5')) return 'mimo-v2.5';
  return process.env.MIMO_TEXT_MODEL_ID || process.env.TEXT_MODEL_ID || 'mimo-v2.5-pro';
};

const buildMimoPayload = (body) => {
  const task = body.task || 'text';
  const baseMessages = [];
  let model = resolveMimoTextModel(body.modelName);
  let maxCompletionTokens = Number(process.env.MIMO_MAX_COMPLETION_TOKENS || 4096);

  if (task === 'media-analysis') {
    const mediaParts = normalizeInputMedia(body.inputMedia || body.media || []);
    if (!mediaParts.length) throw new Error('INPUT_MEDIA_REQUIRED');
    model = process.env.MIMO_VISION_MODEL_ID || 'mimo-v2.5';
    maxCompletionTokens = Number(process.env.MIMO_MEDIA_MAX_COMPLETION_TOKENS || 4096);
    baseMessages.push({ role: 'system', content: process.env.MIMO_MEDIA_SYSTEM_PROMPT || MEDIA_ANALYSIS_SYSTEM_PROMPT });
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
    baseMessages.push({ role: 'system', content: process.env.MIMO_SCRIPT_SYSTEM_PROMPT || DEFAULT_SCRIPT_ASSET_SYSTEM_PROMPT });
    baseMessages.push({ role: 'user', content: body.prompt || '' });
  } else {
    baseMessages.push({ role: 'system', content: process.env.MIMO_TEXT_SYSTEM_PROMPT || DEFAULT_TEXT_GENERATION_SYSTEM_PROMPT });
    baseMessages.push({ role: 'user', content: body.prompt || '' });
  }

  return {
    model,
    messages: baseMessages,
    max_completion_tokens: maxCompletionTokens,
    temperature: Number(process.env.MIMO_TEMPERATURE || 0.7),
    top_p: Number(process.env.MIMO_TOP_P || 0.95),
    stream: false,
    thinking: { type: 'disabled' },
  };
};

const handleImageGeneration = async (req, res) => {
  const body = await readBody(req);
  const count = Math.max(1, Math.min(Number(body.count || 1), 4));

  if (!process.env.SEEDREAM_API_KEY) {
    return json(res, 200, {
      urls: Array.from({ length: count }, (_, index) => mockImage({
        prompt: body.prompt,
        aspectRatio: body.aspectRatio,
        resolution: body.resolution,
        index,
      })),
      mock: true,
    });
  }

  const payload = {
    model: process.env.SEEDREAM_MODEL_ID || 'doubao-seedream-5-0-260128',
    prompt: body.prompt || '',
    sequential_image_generation: 'disabled',
    response_format: 'url',
    size: process.env.SEEDREAM_SIZE || seedreamSize(body.resolution),
    stream: false,
    watermark: process.env.SEEDREAM_WATERMARK !== 'false',
  };
  if (body.inputImages?.length) {
    payload.image = body.inputImages[0];
    payload.image_url = body.inputImages[0];
    payload.reference_image = body.inputImages[0];
  }

  const results = [];
  for (let index = 0; index < count; index += 1) {
    const result = await callModelApi({
      baseUrl: process.env.SEEDREAM_BASE_URL,
      endpoint: process.env.SEEDREAM_IMAGE_ENDPOINT || '/images/generations',
      apiKey: process.env.SEEDREAM_API_KEY,
      payload,
    });
    results.push(...extractUrls(result));
  }

  const urls = [...new Set(results)];
  if (!urls.length) throw new Error('NO_IMAGE_URL_RETURNED');
  json(res, 200, { urls });
};

const handleMultiAngleGeneration = async (req, res) => {
  const body = await readBody(req);
  if (!body.image) return json(res, 400, { error: 'IMAGE_REQUIRED' });
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
      watermark: process.env.QWEN_EDIT_WATERMARK === 'true',
      result_format: 'message',
    };
    if (size) parameters.size = size;

    const result = await callModelApi({
      baseUrl: process.env.QWEN_EDIT_BASE_URL || 'https://dashscope.aliyuncs.com/api/v1',
      endpoint: process.env.QWEN_EDIT_ENDPOINT || '/services/aigc/multimodal-generation/generation',
      apiKey: getQwenEditApiKey(),
      payload: {
        model: process.env.QWEN_EDIT_MODEL || 'qwen-image-edit-plus-2025-12-15',
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
  json(res, 200, { results });
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

const buildAgnesVideoPayload = (body) => {
  const frameRate = Math.max(1, Math.min(Number(process.env.AGNES_VIDEO_FPS) || 24, 60));
  const numFrames = snapAgnesFrames(parseDurationSeconds(body.duration) * frameRate);
  const { width, height } = agnesDimensions(body.aspectRatio, body.resolution);
  const images = Array.isArray(body.inputImages) ? body.inputImages.filter(Boolean) : [];
  // Agnes fetches input images by URL — they must be public http(s) links, not base64/blob.
  const nonPublicImage = images.find((url) => !/^https?:\/\//i.test(url));
  if (nonPublicImage) {
    throw new Error('AGNES_VIDEO_IMAGE_NOT_PUBLIC_URL: 图生视频/首尾帧需要公网图片链接(http/https)。当前连接的是本地图片或 base64，Agnes 无法读取。请改用模型在线生成的图片，或先把图片上传到公网再连。');
  }
  const prompt = (body.prompt && body.prompt.trim())
    || process.env.AGNES_VIDEO_DEFAULT_PROMPT
    || 'Cinematic natural motion with smooth camera movement.';

  const payload = {
    model: process.env.AGNES_VIDEO_MODEL_ID || 'agnes-video-v2.0',
    prompt,
    width,
    height,
    num_frames: numFrames,
    frame_rate: frameRate,
  };

  const inferenceSteps = Number(process.env.AGNES_VIDEO_INFERENCE_STEPS);
  if (Number.isFinite(inferenceSteps) && inferenceSteps > 0) payload.num_inference_steps = inferenceSteps;
  if (process.env.AGNES_VIDEO_NEGATIVE_PROMPT) payload.negative_prompt = process.env.AGNES_VIDEO_NEGATIVE_PROMPT;

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
const SEEDANCE_DEFAULT_BASE = 'https://ark.cn-beijing.volces.com';
const SEEDANCE_DEFAULT_ENDPOINT = '/api/v3/contents/generations/tasks';

const buildSeedancePayload = (body) => {
  const images = Array.isArray(body.inputImages) ? body.inputImages.filter(Boolean) : [];
  const duration = Math.round(parseDurationSeconds(body.duration));
  const watermark = process.env.SEEDANCE_WATERMARK === 'true';

  const flags = [
    `--resolution ${String(body.resolution || '720p')}`,
    `--duration ${duration}`,
    `--watermark ${watermark}`,
    '--camerafixed false',
  ];
  // For image-to-video the ratio is derived from the input image; only force --ratio for text-to-video.
  if (images.length === 0) flags.push(`--ratio ${String(body.aspectRatio || '16:9')}`);

  const prompt = (body.prompt && body.prompt.trim()) || process.env.SEEDANCE_DEFAULT_PROMPT || '';
  const content = [{ type: 'text', text: `${prompt} ${flags.join(' ')}`.trim() }];

  if (body.isStartEndMode && images.length >= 2) {
    content.push({ role: 'first_frame', type: 'image_url', image_url: { url: images[0] } });
    content.push({ role: 'last_frame', type: 'image_url', image_url: { url: images[images.length - 1] } });
  } else {
    for (const url of images) content.push({ type: 'image_url', image_url: { url } });
  }

  return { model: process.env.SEEDANCE_MODEL_ID || 'doubao-seedance-1-5-pro-251215', content };
};

// Create one Seedance task and return immediately. The browser polls for completion.
const createSeedanceTask = async (body) => {
  const apiKey = process.env.SEEDANCE_API_KEY;
  const baseUrl = (process.env.SEEDANCE_BASE_URL || SEEDANCE_DEFAULT_BASE).replace(/\/$/, '');
  const createEndpoint = process.env.SEEDANCE_CREATE_ENDPOINT || process.env.SEEDANCE_VIDEO_ENDPOINT || SEEDANCE_DEFAULT_ENDPOINT;
  const createTimeoutMs = Number(process.env.SEEDANCE_CREATE_TIMEOUT_MS) || 120000;

  const created = await agnesRequest({
    url: joinUrl(baseUrl, createEndpoint),
    apiKey,
    method: 'POST',
    payload: buildSeedancePayload(body),
    timeoutMs: createTimeoutMs,
  });

  const taskId = created.id || created?.data?.id;
  if (!taskId) throw new Error('SEEDANCE_VIDEO_NO_TASK_ID');
  if (String(created.status).toLowerCase() === 'failed') {
    throw new Error(created?.error?.message || 'SEEDANCE_VIDEO_TASK_FAILED');
  }
  return { taskId, videoUrl: created?.content?.video_url || null };
};

// Create one Agnes task and return immediately. The browser polls for completion.
const createAgnesTask = async (body) => {
  const apiKey = process.env.AGNES_VIDEO_API_KEY;
  const baseUrl = (process.env.AGNES_VIDEO_BASE_URL || 'https://apihub.agnes-ai.com').replace(/\/$/, '');
  const createEndpoint = process.env.AGNES_VIDEO_CREATE_ENDPOINT || '/v1/videos';
  const createTimeoutMs = Number(process.env.AGNES_VIDEO_CREATE_TIMEOUT_MS) || 120000;

  const created = await agnesRequest({
    url: joinUrl(baseUrl, createEndpoint),
    apiKey,
    method: 'POST',
    payload: buildAgnesVideoPayload(body),
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

const handleVideoCreate = async (req, res) => {
  const body = await readBody(req);
  const count = Math.max(1, Math.min(Number(body.count) || 1, 4));

  // Primary provider: Volcengine Ark Seedance (doubao-seedance).
  if (process.env.SEEDANCE_API_KEY) {
    const tasks = await Promise.all(Array.from({ length: count }, () => createSeedanceTask(body)));
    if (tasks.every((task) => task.videoUrl)) return json(res, 200, { urls: tasks.map((task) => task.videoUrl) });
    return json(res, 200, { taskIds: tasks.map((task) => task.taskId), provider: 'seedance' });
  }

  // Fallback provider: Agnes Video V2.0.
  if (process.env.AGNES_VIDEO_API_KEY) {
    const tasks = await Promise.all(Array.from({ length: count }, () => createAgnesTask(body)));
    if (tasks.every((task) => task.videoUrl)) return json(res, 200, { urls: tasks.map((task) => task.videoUrl) });
    return json(res, 200, { taskIds: tasks.map((task) => task.taskId), provider: 'agnes' });
  }

  return json(res, 501, { error: 'VIDEO_API_NOT_CONFIGURED' });
};

const handleVideoPoll = async (req, res) => {
  const { searchParams } = new URL(req.url, `http://${req.headers.host}`);
  const taskId = searchParams.get('taskId');
  if (!taskId) return json(res, 400, { error: 'TASK_ID_REQUIRED' });

  // Primary provider: Volcengine Ark Seedance. Must match the provider used by handleVideoCreate.
  if (process.env.SEEDANCE_API_KEY) {
    const baseUrl = (process.env.SEEDANCE_BASE_URL || SEEDANCE_DEFAULT_BASE).replace(/\/$/, '');
    const queryEndpoint = process.env.SEEDANCE_QUERY_ENDPOINT || process.env.SEEDANCE_CREATE_ENDPOINT || process.env.SEEDANCE_VIDEO_ENDPOINT || SEEDANCE_DEFAULT_ENDPOINT;
    const result = await agnesRequest({
      url: joinUrl(baseUrl, `${queryEndpoint}/${encodeURIComponent(taskId)}`),
      apiKey: process.env.SEEDANCE_API_KEY,
      timeoutMs: 20000,
    });
    return json(res, 200, result);
  }

  // Fallback provider: Agnes Video V2.0.
  if (process.env.AGNES_VIDEO_API_KEY) {
    const baseUrl = (process.env.AGNES_VIDEO_BASE_URL || 'https://apihub.agnes-ai.com').replace(/\/$/, '');
    const queryEndpoint = process.env.AGNES_VIDEO_QUERY_ENDPOINT || '/v1/videos';
    const result = await agnesRequest({
      url: joinUrl(baseUrl, `${queryEndpoint}/${encodeURIComponent(taskId)}`),
      apiKey: process.env.AGNES_VIDEO_API_KEY,
      timeoutMs: 20000,
    });
    return json(res, 200, result);
  }

  return json(res, 501, { error: 'VIDEO_API_NOT_CONFIGURED' });
};

const handleAudioGeneration = async (req, res) => {
  const body = await readBody(req);
  const text = String(body.text || body.prompt || '').trim();
  if (!text) return json(res, 400, { error: 'TEXT_REQUIRED' });
  const apiKey = process.env.MINIMAX_TTS_API_KEY || process.env.MINIMAX_API_KEY || process.env.AUDIO_API_KEY;
  if (!apiKey) {
    return json(res, 200, { urls: [mockAudio({ text })], mock: true });
  }

  const result = await callModelApi({
    baseUrl: process.env.MINIMAX_TTS_BASE_URL || process.env.MINIMAX_BASE_URL || process.env.AUDIO_BASE_URL || 'https://api.minimax.io',
    endpoint: getMinimaxTtsEndpoint(),
    apiKey,
    payload: buildMinimaxSpeechPayload({ ...body, text }),
    timeoutMs: 600000,
  });
  const urls = extractAudioUrls(result);
  if (!urls.length) throw new Error('NO_AUDIO_RETURNED');
  json(res, 200, { urls });
};

const handleTextGeneration = async (req, res) => {
  const body = await readBody(req);
  const apiKey = process.env.MIMO_API_KEY || process.env.TEXT_API_KEY;
  const baseUrl = resolveMimoBaseUrl(apiKey);
  const endpoint = process.env.MIMO_TEXT_ENDPOINT || process.env.TEXT_ENDPOINT || '/chat/completions';
  if (!apiKey) {
    return json(res, 200, { text: body.prompt || '' });
  }

  const result = await callTextModelApi({
    baseUrl,
    endpoint,
    apiKey,
    payload: buildMimoPayload(body),
    timeoutMs: 600000,
  });
  json(res, 200, { text: extractText(result), usage: result.usage || null });
};

const handleDirectorLayoutGeneration = async (req, res) => {
  const body = await readBody(req);
  const imageUrl = typeof body?.image?.url === 'string' ? body.image.url.trim() : '';
  if (!imageUrl || !(imageUrl.startsWith('data:image/') || imageUrl.startsWith('http://') || imageUrl.startsWith('https://'))) {
    return json(res, 400, { error: 'DIRECTOR_LAYOUT_IMAGE_REQUIRED' });
  }

  const apiKey = process.env.DIRECTOR_LAYOUT_MODEL_DISABLED === 'true'
    ? ''
    : process.env.MIMO_API_KEY || process.env.TEXT_API_KEY;
  if (!apiKey) return json(res, 501, { error: 'DIRECTOR_LAYOUT_MODEL_NOT_CONFIGURED' });
  const baseUrl = resolveMimoBaseUrl(apiKey);
  const endpoint = process.env.MIMO_TEXT_ENDPOINT || process.env.TEXT_ENDPOINT || '/chat/completions';
  const model = process.env.MIMO_VISION_MODEL_ID || resolveMimoTextModel('2.5');
  let previousText = '';
  let previousIssues = [];

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const correction = attempt === 1
      ? [
          '上一次输出未通过校验。请只修正 JSON 后重新完整输出。',
          `校验错误：${previousIssues.join('；')}`,
          `上一次输出：${previousText.slice(0, 12000)}`,
        ].join('\n')
      : '分析这张参考图并输出粗布景 JSON。';
    const result = await callTextModelApi({
      baseUrl,
      endpoint,
      apiKey,
      payload: {
        model,
        messages: [
          { role: 'system', content: process.env.MIMO_DIRECTOR_LAYOUT_SYSTEM_PROMPT || DIRECTOR_LAYOUT_SYSTEM_PROMPT },
          {
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: imageUrl } },
              { type: 'text', text: correction },
            ],
          },
        ],
        max_completion_tokens: Number(process.env.MIMO_DIRECTOR_LAYOUT_MAX_COMPLETION_TOKENS || 4096),
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
      return json(res, 200, { draft, usage: result.usage || null });
    } catch (error) {
      previousIssues = Array.isArray(error?.issues) ? error.issues.slice(0, 12) : [error?.message || '布局 JSON 无效'];
    }
  }

  return json(res, 502, {
    error: 'DIRECTOR_LAYOUT_INVALID_MODEL_JSON',
    message: '视觉模型两次返回的数据都不符合布局格式',
    issues: previousIssues,
  });
};

const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
};

const serveStatic = (req, res) => {
  const requestPath = decodeURIComponent(new URL(req.url, `http://${req.headers.host}`).pathname);
  const safePath = path.normalize(requestPath).replace(/^(\.\.[/\\])+/, '');
  let filePath = path.join(distDir, safePath === '/' ? 'index.html' : safePath);
  if (!filePath.startsWith(distDir)) return json(res, 403, { error: 'FORBIDDEN' });
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(distDir, 'index.html');
  }
  const ext = path.extname(filePath);
  res.writeHead(200, { 'Content-Type': contentTypes[ext] || 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(res);
};

const server = http.createServer(async (req, res) => {
  try {
    const { pathname } = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === 'POST' && pathname === '/api/auth/login') {
      const body = await readBody(req);
      if (body.password !== LOGIN_PASSWORD) return json(res, 401, { error: 'INVALID_PASSWORD' });
      return json(res, 200, { token: createToken() });
    }

    if (pathname === '/api/auth/me') {
      if (!requireAuth(req, res)) return;
      return json(res, 200, { ok: true });
    }

    if (req.method === 'GET' && pathname.startsWith('/api/media/')) {
      return handleMediaGet(req, res, pathname);
    }

    if (pathname.startsWith('/api/')) {
      if (!requireAuth(req, res)) return;
      if (req.method === 'POST' && pathname === '/api/media/upload') return await handleMediaUpload(req, res);
      if (req.method === 'POST' && pathname === '/api/generate/image') return await handleImageGeneration(req, res);
      if (req.method === 'POST' && pathname === '/api/generate/multi-angle') return await handleMultiAngleGeneration(req, res);
      if (req.method === 'POST' && pathname === '/api/generate/video') return await handleVideoCreate(req, res);
      if (req.method === 'GET' && pathname === '/api/generate/video/poll') return await handleVideoPoll(req, res);
      if (req.method === 'POST' && pathname === '/api/generate/audio') return await handleAudioGeneration(req, res);
      if (req.method === 'POST' && pathname === '/api/generate/text') return await handleTextGeneration(req, res);
      if (req.method === 'POST' && pathname === '/api/director-layout') return await handleDirectorLayoutGeneration(req, res);
      return json(res, 404, { error: 'NOT_FOUND' });
    }

    serveStatic(req, res);
  } catch (error) {
    console.error(error);
    json(res, error.statusCode || 500, { error: error.message || 'SERVER_ERROR' });
  }
});

server.listen(PORT, () => {
  console.log(`KC Canvas server listening on http://127.0.0.1:${PORT}`);
});
