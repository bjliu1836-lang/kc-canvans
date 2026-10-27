import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DIRECTOR_LAYOUT_OBSERVATION_FORMAT,
  DIRECTOR_LAYOUT_OBSERVATION_FORMAT_V2,
  DIRECTOR_LAYOUT_OBSERVATION_SYSTEM_PROMPT,
  DIRECTOR_LAYOUT_OBSERVATION_V2_SYSTEM_PROMPT,
  DIRECTOR_LAYOUT_SPATIAL_REVIEW_SYSTEM_PROMPT,
  DIRECTOR_LAYOUT_SPATIAL_REVIEW_MAX_COMPLETION_TOKENS,
  normalizeDirectorLayoutReferenceImages,
  buildDirectorLayoutImageContent,
  buildDirectorLayoutSpatialReviewPrompt,
  directorLayoutPromptHash,
  directorLayoutSpatialReviewPatch,
  parseDirectorLayoutSpatialReview,
  extractDirectorLayoutFinishReason,
  resolveDirectorLayoutObservationTokenBudget,
  parseDirectorLayoutObservation,
  parseDirectorLayoutObservationV2,
  summarizeDirectorLayoutProviderEnvelope,
  summarizeDirectorLayoutObservationOutput,
} from '../functions/shared/director-layout-observations.js';

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

const readBody = async (req, maxBytes = Infinity) => {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.byteLength;
    if (total > maxBytes) throw new Error('DIRECTOR_LAYOUT_REQUEST_TOO_LARGE');
    chunks.push(chunk);
  }
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
  '你是 3D 影视预演的室内粗布景与人物占位分析器。',
  '一次请求可能包含1到3张同一场景参考图。图1是唯一主图和二维坐标基准，其余是补充视角；必须综合全部图像输出一份融合布景，不得分别识别后复制对象。所有坐标只使用图1主图坐标；补图仅辅助核对身份、关系、遮挡和可见性，不能把补图像素框直接当作主图坐标。补图独见且无法可靠映射到主图的对象不得编造位置；视角冲突或对象身份不确定时不强行合并、复制或移动对象，应保留不确定性待复核。不要虚构图中不可见的精细结构。',
  '先判断空间类型 spaceType：enclosed（明确封闭）、open（开放但有可见边界）、outdoor（室外）、unknown（无法判断）。开放/室外只输出图中确实可见的墙、围栏或立面；禁止补齐看不见的四面墙。',
  '========== 第一部分：布景组件 components ==========',
  '只识别这些 category：ground, wall, door, window, table, chair, sofa, cabinet, pillar, prop。pillar 表示从支撑面延伸到顶面的柱；prop 表示香炉、花瓶、雕像等需要占位的非家具物件。',
  '只使用这些 primitive：box, cylinder。不要返回模型名、GLB、纹理或外部资产。',
  '床不是合法 category：如图中有床，只输出床体一个 sofa + box 组件并给 semanticType="bed"；现有 bed 语义预设已在该床体内表达床架、床垫、床头板和枕头，不要把这些预设内部子部件重复输出为同级 components。head_at 关系必须 fromId=床体组件（semanticType="bed"）、toId=该床所属 wall；床体 local -Z 为床头方向。不要使用床头板→床体或床头板→墙作为 head_at。',
  '共享右手世界基准以参考机位为准：+X 为画面右，+Y 向上，+Z 朝观察者/默认机位，-Z 为后墙方向。透视倾斜时，依据墙线和消失方向判断房间轴；不要把屏幕二维左右、上下或像素距离直接当作世界距离或米。',
  '坐标单位是米；position 是物体底面中心，也是物体与支撑面的接触中心：落地物体 Y=地面高度，桌台上的香炉、花瓶、雕像等 prop 的 Y=承载台面高度，不能把所有组件 Y 都写成 0。size 顺序是局部宽、高、深，且每项必须大于 0。yaw=0 时局部 width 沿 +X、local depth 沿 +Z；正 rotationYDegrees 使 local +Z 转向 +X。size 只写局部尺寸，rotationYDegrees 只写朝向，不能把宽深旋转两次。',
  '提交前逐项检查 Y 语义：落地 wall、pillar 的 position.y 通常等于地面高度 0，而不是 size[1]/2；例如 3 米高的落地墙应写 position.y=0、size[1]=3，不能写 position.y=1.5。window、桌面 prop 等悬空物体仍写真实支撑面高度，不得统一贴地。',
  '柜体或有开口面的家具，局部正面/开放面定义为 local +Z；床体的床头定义在 local -Z，床头板与床体分别输出并邻近该端。普通 box 的前后或 +/-180 度视觉不可区分时，在 notes 写明朝向依据或不确定性，不要假装可从对称外形恢复。',
  '组件可选输出 semanticType（短英文语义标签，最多48字母/数字/下划线/连字符；例如 bed、bookshelf、curtain），不改变 category。modelDescriptor（不超过120字）和 appearance 只在图像证据清楚时输出；对原图中主色明确可辨的组件，必须输出 appearance.color 近似值（格式 #RRGGBB），不要因为客户端有中性类别色 fallback 而省略；颜色被遮挡、过暗或无法可靠分辨时才省略并将 uncertain 置为 true 或降低 confidence。roughness/metalness 只有图像证据足以支持时才输出，范围 0 到 1；frontDirectionDegrees 表示局部 +Z 正面方向。示例 appearance 结构：{"color":"#8A6741","roughness":0.7,"metalness":0.0}，其中颜色仅演示合法字段格式，不能套用于图中物件。它们只驱动已有程序构件/本地库外观，不得输出外部模型、GLB 或纹理。',
  '需要精确轮廓的关键物件可输出 assembly，最多24个局部轴对齐子件。现有可复用 semanticType 预设为 bed、curtain、bookshelf：优先为该对象输出一个父组件并使用对应预设，不要再把预设内部子部件重复输出为同级 components；这几类组件可省略 assembly。没有可用预设、但可见轮廓明确由多个主要部分组成的物件，应使用少量有证据的 assembly 子件表达，不要把明显的多部分轮廓都退化为单一 box/cylinder。primitive 只能为 box/cylinder/sphere/cone/torus，position 和 size 均为父组件包围盒内的归一化三元组；position 每项0到1，size每项大于0且不超过1，position±size/2 不得越界，rotation 如出现必须为 [0,0,0]。仅编码影响轮廓的主要部分，单个组件建议不超过8件；细小装饰、材质纹理或缺乏可见证据的部件不输出，避免堆砌子件。不得执行代码或输出任意几何。',
  '先识别空间关系，再填写坐标：门、窗依附所在墙面；柱应从可见支撑面延伸到顶面；门洞附近的墙应拆成门洞左右或上方的墙段，不要用一整块墙堵住门洞；家具长轴、柜开放面、床头端与相邻墙/家具的关系要自洽；承载于桌台的 prop 必须保持与对应台面的垂直层次。床头柜（cabinet）应靠近床头端，并按原图语义视角判断左右，不能按世界X轴或自由机位判断。以上是一般关系规则，不能硬编码为某个房间。',
  '最多输出12条 observations，每条包含可选 componentId、state（visible/occluded/cropped/ambiguous）、confidence（0..1）和可选简短 evidence。最多24条 relations，每条包含 fromId、toId、type（attached_to/adjacent_to/supports/head_at/parallel_to/faces/left_of/right_of）和 confidence（0..1）；只输出看得清且有用的关系，端点必须引用 components 中稳定 id。缺证据就省略，不得猜。left_of/right_of 永远表示原图观察者视角。attached_to 只用于门窗等薄面附着物；head_at 必须从床体组件（semanticType=bed）指向所属 wall，表达床体 local -Z 床头端靠墙；不得反向填写，也不得引用床头板等 assembly/preset 内部子部件作为关系端点。',
  '输出 referenceCamera 作为参考图的透视起始机位：projection 固定 perspective，position 与 target 都是世界米坐标，fov 为 20 到 100 的度数，confidence 为 0 到 1。单张图无法可靠恢复时宁可降低 confidence；它只用于同画幅对照，不得把它当作真实拍摄内参。',
  '组件明确承载在另一组件的水平顶面时，输出 supportComponentId=承载组件 id；只允许引用 ground、table、cabinet、prop。不要用 wall/window/door/pillar 作为水平支撑。chair/sofa 的包围盒顶通常不是座面，坐姿人物不要引用整个 chair/sofa；没有独立可确认座面组件时省略 supportComponentId，并直接填写观察到的座面 Y。',
  '最多 30 个组件。无法确认的物体请降低 confidence 并设置 uncertain=true。',
  '========== 第二部分：人物 characters ==========',
  '识别图中所有人物，最多 8 个；人物要创建为可编辑的角色占位，只做站位与姿态，不要还原脸、服装和体型。',
  'posture 只能取：stand（站）, sit（坐）, crouch（蹲）, kneel（跪）, lie（躺/卧）, unknown（看不清）。',
  'posture=kneel 时必须额外输出 kneelVariant：one-knee（单膝跪）, two-knee（双膝直身跪）, seiza（双腿收在臀下、臀部落向脚跟的跪坐）。不要把 seiza 误写成向前迈腿的 one-knee。其他 posture 不要输出 kneelVariant。',
  '人物明确双手合十时输出 handGesture="prayer"；其他手势或看不清时省略 handGesture，不要用跪姿默认推断合十。',
  'bodyTypeHint 只能取：male, female, unknown。',
  'position 是"身体与支撑面的接触中心"，Y 必须等于支撑面高度：站/蹲/跪在地面或坐垫时 Y=对应地面或坐垫顶面高度，坐在沙发或椅子上时 Y=该座面高度（约 0.40~0.50），躺在床上时 Y=床面高度。绝对不要把所有人物的 Y 都写成 0。',
  '人物站、蹲、跪在明确的 ground 或独立平台/坐垫 prop 上时，也输出 supportComponentId=该承载组件 id。引用必须存在、不能引用自身、不能形成循环。',
  '雕像、佛像、画像中的人物和玩偶属于 prop 或背景，不得写入 characters；只有画面中的真人/表演角色才创建人物占位。',
  'rotationYDegrees 是人物面朝方向，0 表示面朝 +Z（朝向默认机位），90 表示面朝 +X，-90 表示面朝 -X，180 表示背对机位。',
  '========== 尺度：最关键的要求 ==========',
  '整张图只能使用一次统一的比例尺（uniform scale）。先依据深度、遮挡、地面、墙线和可见连接关系估计三维比例：原图中约 1:10 的关系不能被常识改成 1:5；远处物体像素更小可能来自透视，不等于它在三维中更小。禁止逐个物体按常见尺寸重新缩放。',
  '无人图：只根据可见建筑、家具和空间关系选择尺度锚点，不要虚构人物。有人图：人物、家具和空间共用同一把尺；优先以可见的已知尺度锚点校准，坐姿、遮挡或局部人物不可强制当作站立 1.7 米。',
  '成年人身高、门高、座面高、沙发宽、餐桌高等常识只用于选择或校验统一尺度，不能覆盖图中已观察到的相对关系。参考范围：站立成年人约 1.6~1.8 米、坐姿座面到头顶约 0.9 米、座面约 0.45 米、标准门高约 2.05 米。',
  'height 是人物估算身高，必须在 0.5 到 2.5 米之间；看不清时保留同一尺度下的估计并降低 confidence/设置 uncertain=true，不要用默认成年身高破坏图中比例。',
  '========== 输出格式 ==========',
  'scale.mode 固定为 estimated。必须返回 spaceType、observations、relations；没有证据时 spaceType="unknown" 且 observations/relations 用空数组。没有要创建的人物时输出空数组 characters: []，不要省略该字段。',
  '无法确认的人物请降低 confidence 并设置 uncertain=true（例如被遮挡、只露出部分身体）。',
  '只输出一个 JSON 对象，不要 Markdown，不要解释。格式：',
  '{"spaceType":"enclosed","observations":[{"componentId":"pillar_01","state":"visible","confidence":0.8,"evidence":"顶面可见"}],"relations":[],"scale":{"mode":"estimated","confidence":0.4},"referenceCamera":{"projection":"perspective","position":[0,1.6,8],"target":[0,1.2,-2],"fov":50,"confidence":0.35},"components":[{"id":"pillar_01","name":"立柱","category":"pillar","primitive":"cylinder","semanticType":"pillar","position":[0,0,-3],"size":[0.45,2.8,0.45],"rotationYDegrees":0,"confidence":0.8,"uncertain":false,"notes":""}],"characters":[]}'
].join('\n');

const DIRECTOR_LAYOUT_CATEGORIES = new Set(['ground', 'wall', 'door', 'window', 'table', 'chair', 'sofa', 'cabinet', 'pillar', 'prop']);
const DIRECTOR_LAYOUT_PRIMITIVES = new Set(['box', 'cylinder']);
const DIRECTOR_LAYOUT_HORIZONTAL_SUPPORT_CATEGORIES = new Set(['ground', 'table', 'cabinet', 'prop']);
const DIRECTOR_LAYOUT_POSTURES = new Set(['stand', 'sit', 'crouch', 'kneel', 'lie', 'unknown']);
const DIRECTOR_LAYOUT_KNEEL_VARIANTS = new Set(['one-knee', 'two-knee', 'seiza']);
const DIRECTOR_LAYOUT_HAND_GESTURES = new Set(['prayer']);
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
  const referenceCamera = candidate?.referenceCamera;
  if (referenceCamera !== undefined) {
    const finiteTuple = (value) => Array.isArray(value) && value.length === 3
      && value.every(number => typeof number === 'number' && Number.isFinite(number));
    if (!referenceCamera || typeof referenceCamera !== 'object' || Array.isArray(referenceCamera)
      || referenceCamera.projection !== 'perspective'
      || !finiteTuple(referenceCamera.position)
      || !finiteTuple(referenceCamera.target)
      || typeof referenceCamera.fov !== 'number' || !Number.isFinite(referenceCamera.fov) || referenceCamera.fov < 20 || referenceCamera.fov > 100
      || typeof referenceCamera.confidence !== 'number' || !Number.isFinite(referenceCamera.confidence) || referenceCamera.confidence < 0 || referenceCamera.confidence > 1) {
      issues.push('referenceCamera 必须包含 perspective、position、target、20 到 100 的 fov 与 0 到 1 的 confidence');
    }
  }
  const assemblyPartFits = (part) => {
    if (!part || typeof part !== 'object' || !['box', 'cylinder', 'sphere', 'cone', 'torus'].includes(part.primitive)
      || !Array.isArray(part.position) || part.position.length !== 3 || !part.position.every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1)
      || !Array.isArray(part.size) || part.size.length !== 3 || !part.size.every(value => typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 1)
      || (part.rotation !== undefined && (!Array.isArray(part.rotation) || part.rotation.length !== 3 || !part.rotation.every(value => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 360)))
      || (part.opacity !== undefined && (typeof part.opacity !== 'number' || !Number.isFinite(part.opacity) || part.opacity < 0.15 || part.opacity > 1))) return false;
    const [rx, ry, rz] = (part.rotation || [0, 0, 0]).map(value => value * Math.PI / 180);
    const sx = Math.sin(rx), cx = Math.cos(rx), sy = Math.sin(ry), cy = Math.cos(ry), sz = Math.sin(rz), cz = Math.cos(rz);
    const matrix = [[cy * cz, -cy * sz, sy], [sx * sy * cz + cx * sz, -sx * sy * sz + cx * cz, -sx * cy], [-cx * sy * cz + sx * sz, cx * sy * sz + sx * cz, cx * cy]];
    return part.position.every((value, axis) => {
      const half = matrix[axis].reduce((sum, coefficient, otherAxis) => sum + Math.abs(coefficient) * part.size[otherAxis] / 2, 0);
      return value - half >= 0 && value + half <= 1;
    });
  };
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
    if (item.modelDescriptor !== undefined && (typeof item.modelDescriptor !== 'string' || item.modelDescriptor.trim().length > 120)) {
      issues.push(`${label}的 modelDescriptor 必须是不超过 120 字的字符串`);
    }
    if (item.appearance !== undefined) {
      const appearance = item.appearance;
      const validColor = appearance && typeof appearance === 'object' && !Array.isArray(appearance)
        && (appearance.color === undefined || (typeof appearance.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(appearance.color.trim())))
        && (appearance.roughness === undefined || (typeof appearance.roughness === 'number' && Number.isFinite(appearance.roughness) && appearance.roughness >= 0 && appearance.roughness <= 1))
        && (appearance.metalness === undefined || (typeof appearance.metalness === 'number' && Number.isFinite(appearance.metalness) && appearance.metalness >= 0 && appearance.metalness <= 1))
        && (appearance.frontDirectionDegrees === undefined || (typeof appearance.frontDirectionDegrees === 'number' && Number.isFinite(appearance.frontDirectionDegrees)));
      if (!validColor) issues.push(`${label}的 appearance 必须包含合法颜色、材质数值或正面方向`);
    }
    if (item.assembly !== undefined) {
      const validAssembly = Array.isArray(item.assembly) && item.assembly.length > 0 && item.assembly.length <= 24 && item.assembly.every(assemblyPartFits);
      if (!validAssembly) issues.push(`${label}的 assembly 必须是父组件包围盒内最多24个轴对齐受限子件`);
    }
    if (typeof item.confidence !== 'number' || !Number.isFinite(item.confidence) || item.confidence < 0 || item.confidence > 1) {
      issues.push(`${label}的置信度必须在 0 到 1 之间`);
    }
    const id = typeof item.id === 'string' ? item.id.trim() : '';
    if (!id) issues.push(`${label}缺少 id`);
    else if (ids.has(id)) issues.push(`${label}的 id 重复`);
    ids.add(id);
  });
  const componentById = new Map((components || [])
    .filter(item => item && typeof item === 'object' && typeof item.id === 'string' && item.id.trim())
    .map(item => [item.id.trim(), item]));
  const supportFootprintContains = (position, support) => {
    if (!Array.isArray(position) || position.length !== 3 || !position.every(Number.isFinite)
      || !Array.isArray(support?.position) || support.position.length !== 3 || !support.position.every(Number.isFinite)
      || !Array.isArray(support?.size) || support.size.length !== 3 || !support.size.every(Number.isFinite)) return false;
    const radians = Number(support.rotationYDegrees || 0) * Math.PI / 180;
    const dx = position[0] - support.position[0];
    const dz = position[2] - support.position[2];
    const localX = Math.cos(radians) * dx - Math.sin(radians) * dz;
    const localZ = Math.sin(radians) * dx + Math.cos(radians) * dz;
    return Math.abs(localX) <= support.size[0] / 2 + 0.04 && Math.abs(localZ) <= support.size[2] / 2 + 0.04;
  };
  const openingAttachedToWall = (opening) => (components || []).some((wall) => {
    if (!wall || wall.category !== 'wall' || !Array.isArray(wall.position) || !Array.isArray(wall.size)) return false;
    if (!Array.isArray(opening.position) || !Array.isArray(opening.size)) return false;
    const wallYaw = Number(wall.rotationYDegrees || 0);
    const openingYaw = Number(opening.rotationYDegrees || 0);
    const wallRunsAlongX = wall.size[0] >= wall.size[2];
    const expectedOpeningYaw = wallYaw + (wallRunsAlongX ? 0 : 90);
    const halfTurnDifference = Math.abs(((openingYaw - expectedOpeningYaw + 90) % 180 + 180) % 180 - 90);
    if (halfTurnDifference > 18) return false;
    const radians = wallYaw * Math.PI / 180;
    const dx = opening.position[0] - wall.position[0];
    const dz = opening.position[2] - wall.position[2];
    const localX = Math.cos(radians) * dx - Math.sin(radians) * dz;
    const localZ = Math.sin(radians) * dx + Math.cos(radians) * dz;
    const alongWall = wallRunsAlongX ? localX : localZ;
    const acrossWall = wallRunsAlongX ? localZ : localX;
    const wallLength = wallRunsAlongX ? wall.size[0] : wall.size[2];
    const wallThickness = wallRunsAlongX ? wall.size[2] : wall.size[0];
    const verticalOverlap = opening.position[1] <= wall.position[1] + wall.size[1] + 0.12
      && opening.position[1] + opening.size[1] >= wall.position[1] - 0.12;
    return verticalOverlap
      && Math.abs(alongWall) + opening.size[0] / 2 <= wallLength / 2 + 0.12
      && Math.abs(acrossWall) <= (wallThickness + opening.size[2]) / 2 + 0.18;
  });
  const appendOpeningDiagnostic = (notes, diagnostic) => {
    const current = typeof notes === 'string' ? notes.trim().slice(0, 240) : '';
    if (current.includes(diagnostic)) return current;
    const prefix = current.slice(0, Math.max(0, 239 - diagnostic.length)).replace(/[；\s]+$/g, '');
    return (prefix ? `${prefix}；` : '') + diagnostic.slice(0, 240);
  };
  components?.forEach((item, index) => {
    if (!item || typeof item !== 'object' || item.supportComponentId === undefined) return;
    const label = `第 ${index + 1} 个组件`;
    const supportId = typeof item.supportComponentId === 'string' ? item.supportComponentId.trim() : '';
    if (!supportId) issues.push(`${label}的 supportComponentId 必须是非空字符串`);
    else if (supportId === item.id) issues.push(`${label}不能把自身作为支撑组件`);
    else if (!componentById.has(supportId)) issues.push(`${label}引用了不存在的支撑组件 ${supportId}`);
    else if (!DIRECTOR_LAYOUT_HORIZONTAL_SUPPORT_CATEGORIES.has(componentById.get(supportId).category)) {
      issues.push(`${label}引用的 ${supportId} 不是可按包围盒顶面计算的水平支撑`);
    } else if (!supportFootprintContains(item.position, componentById.get(supportId))) {
      issues.push(`${label}与支撑组件 ${supportId} 的水平足迹不重叠`);
    }
  });
  const diagnosedComponents = (components || []).map((item) => {
    if (!item || typeof item !== 'object' || !['door', 'window'].includes(item.category) || openingAttachedToWall(item)) return item;
    const label = `${item.category === 'door' ? '门' : '窗'}未依附可识别墙面，待确认位置与朝向`;
    return { ...item, uncertain: true, notes: appendOpeningDiagnostic(item.notes, label) };
  });
  const supportVisitState = new Map();
  const visitSupport = (id) => {
    const state = supportVisitState.get(id);
    if (state === 'visiting') return true;
    if (state === 'done') return false;
    supportVisitState.set(id, 'visiting');
    const supportId = componentById.get(id)?.supportComponentId;
    const cyclic = typeof supportId === 'string' && componentById.has(supportId) && visitSupport(supportId);
    supportVisitState.set(id, 'done');
    return cyclic;
  };
  componentById.forEach((_item, id) => {
    if (visitSupport(id)) issues.push(`组件 ${id} 的支撑关系形成循环`);
  });

  // 新模型响应必须显式给出 characters（无人图为 []）；客户端仍兼容旧草稿缺字段。
  const rawCharacters = candidate?.characters;
  if (!Array.isArray(rawCharacters)) issues.push('布局结果缺少 characters 数组');
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
    if (item.posture === 'kneel' && !DIRECTOR_LAYOUT_KNEEL_VARIANTS.has(item.kneelVariant)) {
      issues.push(`${label}的跪姿缺少有效 kneelVariant`);
    }
    if (item.kneelVariant !== undefined && !DIRECTOR_LAYOUT_KNEEL_VARIANTS.has(item.kneelVariant)) {
      issues.push(`${label}包含未知跪姿细分 ${String(item.kneelVariant)}`);
    }
    if (item.handGesture !== undefined && !DIRECTOR_LAYOUT_HAND_GESTURES.has(item.handGesture)) {
      issues.push(`${label}包含未知手势 ${String(item.handGesture)}`);
    }
    if (item.supportComponentId !== undefined) {
      const supportId = typeof item.supportComponentId === 'string' ? item.supportComponentId.trim() : '';
      const support = componentById.get(supportId);
      if (!supportId) issues.push(`${label}的 supportComponentId 必须是非空字符串`);
      else if (!support) issues.push(`${label}引用了不存在的支撑组件 ${supportId}`);
      else if (!DIRECTOR_LAYOUT_HORIZONTAL_SUPPORT_CATEGORIES.has(support.category)) {
        issues.push(`${label}引用的 ${supportId} 不是可按包围盒顶面计算的水平支撑`);
      } else if (!supportFootprintContains(item.position, support)) {
        issues.push(`${label}与支撑组件 ${supportId} 的水平足迹不重叠`);
      }
    }
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
  return components ? { ...candidate, components: diagnosedComponents } : candidate;
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
  let body;
  try { body = await readBody(req, 20 * 1024 * 1024); }
  catch (error) { return json(res, error?.message === 'DIRECTOR_LAYOUT_REQUEST_TOO_LARGE' ? 413 : 400, { error: error?.message || 'DIRECTOR_LAYOUT_REQUEST_INVALID' }); }
  const observationV2 = body?.outputFormat === DIRECTOR_LAYOUT_OBSERVATION_FORMAT_V2;
  const observationMode = body?.outputFormat === DIRECTOR_LAYOUT_OBSERVATION_FORMAT || observationV2;
  const spatialReview = body?.observationStage === 'spatial-review';
  if (body?.outputFormat !== undefined && !observationMode) return json(res, 400, { error: 'DIRECTOR_LAYOUT_FORMAT_UNSUPPORTED' });
  if (body?.observationStage !== undefined && (!observationMode || !spatialReview)) return json(res, 400, { error: 'DIRECTOR_LAYOUT_STAGE_UNSUPPORTED' });
  let referenceImages;
  try {
    referenceImages = normalizeDirectorLayoutReferenceImages(body);
  } catch (error) {
    return json(res, 400, { error: error?.message || 'DIRECTOR_LAYOUT_IMAGES_INVALID' });
  }

  const apiKey = process.env.DIRECTOR_LAYOUT_MODEL_DISABLED === 'true'
    ? ''
    : process.env.MIMO_API_KEY || process.env.TEXT_API_KEY;
  if (!apiKey) return json(res, 501, { error: 'DIRECTOR_LAYOUT_MODEL_NOT_CONFIGURED' });
  const baseUrl = resolveMimoBaseUrl(apiKey);
  const endpoint = process.env.MIMO_TEXT_ENDPOINT || process.env.TEXT_ENDPOINT || '/chat/completions';
  const model = process.env.MIMO_VISION_MODEL_ID || resolveMimoTextModel('2.5');
  if (observationMode) {
    let systemPrompt = observationV2 ? DIRECTOR_LAYOUT_OBSERVATION_V2_SYSTEM_PROMPT : DIRECTOR_LAYOUT_OBSERVATION_SYSTEM_PROMPT;
    let userPrompt = observationV2
      ? '请综合分析本次全部同等地位的参考视图。每个二维事实必须标记sourceId，只返回一份唯一实体集合和逐视图观察JSON。'
      : '请按约定综合本次全部参考图，只返回一份以主图为唯一坐标系的二维融合观察 JSON。';
    if (spatialReview) {
      try {
        if (observationV2) {
          systemPrompt = `${DIRECTOR_LAYOUT_OBSERVATION_V2_SYSTEM_PROMPT}\n复核时返回完整替换观察；可纠正身份、类别、bbox和漏识别，但保留可确认的稳定entityId。`;
          userPrompt = `请复核完整视图组并返回完整的image-observations-v2替换结果。sourceId集合必须与输入严格相同。候选观察：${JSON.stringify(body.baseObservations)}`;
        } else {
          systemPrompt = DIRECTOR_LAYOUT_SPATIAL_REVIEW_SYSTEM_PROMPT;
          userPrompt = buildDirectorLayoutSpatialReviewPrompt(body.baseObservations, body.reviewContext);
        }
      } catch {
        return json(res, 400, { error: 'DIRECTOR_LAYOUT_SPATIAL_REVIEW_CONTEXT_INVALID' });
      }
    }
    const promptHash = await directorLayoutPromptHash(`${systemPrompt}\n---\n${userPrompt}`, crypto.webcrypto.subtle);
    let result;
    try {
      result = await callModelApi({
      baseUrl, endpoint, apiKey,
      payload: {
        model,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: buildDirectorLayoutImageContent(referenceImages, userPrompt, { multiView: observationV2 }) },
        ],
        max_completion_tokens: spatialReview
          ? resolveDirectorLayoutObservationTokenBudget(process.env.DIRECTOR_LAYOUT_SPATIAL_REVIEW_MAX_COMPLETION_TOKENS, DIRECTOR_LAYOUT_SPATIAL_REVIEW_MAX_COMPLETION_TOKENS)
          : resolveDirectorLayoutObservationTokenBudget(process.env.DIRECTOR_LAYOUT_OBSERVATION_MAX_COMPLETION_TOKENS),
        temperature: 0.1,
        top_p: 0.9,
        stream: false,
        ...(spatialReview
          ? { thinking: { type: 'enabled' }, reasoning_effort: 'max' }
          : { thinking: { type: 'disabled' } }),
      },
      timeoutMs: spatialReview ? 600000 : 180000,
      });
    } catch (error) {
      const upstreamStatus = Number.isInteger(error?.statusCode) ? error.statusCode : null;
      return json(res, upstreamStatus || 502, {
        error: upstreamStatus ? 'DIRECTOR_LAYOUT_UPSTREAM_HTTP' : 'DIRECTOR_LAYOUT_UPSTREAM_FAILURE',
        message: '视觉模型上游请求失败',
        ...(upstreamStatus ? { upstreamStatus } : {}),
      });
    }
    const modelText = extractText(result);
    if (!modelText.trim()) return json(res, 502, {
      error: 'DIRECTOR_LAYOUT_UPSTREAM_RESPONSE_INVALID',
      message: '视觉模型上游响应缺少文本内容',
      providerEnvelope: summarizeDirectorLayoutProviderEnvelope(result),
    });
    const outputShape = summarizeDirectorLayoutObservationOutput(modelText);
    const finishReason = extractDirectorLayoutFinishReason(result);
    if (["length", "max_tokens", "max_completion_tokens"].includes(String(finishReason || "").toLowerCase())) return json(res, 422, {
      error: 'DIRECTOR_LAYOUT_MODEL_OUTPUT_TRUNCATED',
      message: '视觉模型输出达到长度上限，未应用不完整观察结果，请减少参考图或重试',
      outputShape,
      providerFinishReason: finishReason,
      providerModel: typeof result?.model === 'string' ? result.model.slice(0, 100) : null,
      promptHash,
    });
    try {
      const visualObservations = observationV2
        ? parseDirectorLayoutObservationV2(modelText, referenceImages.map((image) => image.sourceId).filter(Boolean))
        : spatialReview ? parseDirectorLayoutSpatialReview(modelText) : parseDirectorLayoutObservation(modelText);
      const responseObservations = spatialReview && !observationV2
        ? directorLayoutSpatialReviewPatch(body.baseObservations, visualObservations)
        : visualObservations;
      return json(res, 200, {
        observationFormat: observationV2 ? DIRECTOR_LAYOUT_OBSERVATION_FORMAT_V2 : DIRECTOR_LAYOUT_OBSERVATION_FORMAT,
        ...(spatialReview ? { spatialReviewPatch: responseObservations } : { visualObservations: responseObservations }),
        providerOutputShape: outputShape,
        providerFinishReason: extractDirectorLayoutFinishReason(result),
        providerModel: typeof result?.model === 'string' ? result.model.slice(0, 100) : null,
        promptHash,
        usage: result.usage || null,
      });
    } catch (error) {
      return json(res, 422, {
        error: error?.kind === 'model-json' ? 'DIRECTOR_LAYOUT_MODEL_JSON_INVALID' : 'DIRECTOR_LAYOUT_MODEL_SCHEMA_INVALID',
        message: error?.kind === 'model-json' ? '视觉模型返回内容不是有效 JSON' : '视觉模型 JSON 未通过观察结构校验',
        issues: error?.issues || ['图像观察结构无效'],
        issuePaths: error?.issuePaths || [],
        outputShape,
        providerFinishReason: extractDirectorLayoutFinishReason(result),
        providerModel: typeof result?.model === 'string' ? result.model.slice(0, 100) : null,
        promptHash,
      });
    }
  }
  let previousText = '';
  let previousIssues = [];

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const correction = attempt === 1
      ? [
          '上一次输出未通过校验。请只修正 JSON 后重新完整输出，必须同时包含 components 与 characters 两个字段；仍须综合本次全部同一场景参考图，并只用图1主图坐标。',
          `校验错误：${previousIssues.join('；')}`,
          `上一次输出：${previousText.slice(0, 12000)}`,
        ].join('\n')
      : '请综合本次全部同一场景参考图，输出一份粗布景组件与人物占位的 JSON；所有坐标以图1主图为唯一基准，补图只提供辅助证据。';
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
              ...buildDirectorLayoutImageContent(referenceImages, correction),
            ],
          },
        ],
        max_completion_tokens: Number(process.env.MIMO_DIRECTOR_LAYOUT_MAX_COMPLETION_TOKENS || 6144),
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
    // 目录请求（如 /director-desk/）：若该目录自带 index.html 则优先返回它，
    // 与 Cloudflare Pages 的目录索引行为一致；否则回退到 SPA 入口。
    const dirIndex = path.join(filePath, 'index.html');
    if (fs.existsSync(dirIndex) && fs.statSync(dirIndex).isFile()) {
      filePath = dirIndex;
    } else {
      filePath = path.join(distDir, 'index.html');
    }
  }
  const ext = path.extname(filePath);
  // HTML 入口禁止缓存：否则新构建后浏览器仍拿旧 index.html，继续加载上一版 assets。
  // 带 hash 的 assets/ 可长缓存（文件名变了自然失效），其余静态资源给短缓存。
  const relativePath = path.relative(distDir, filePath).split(path.sep).join('/');
  const cacheControl = ext === '.html'
    ? 'no-cache, must-revalidate'
    : relativePath.startsWith('assets/')
      ? 'public, max-age=31536000, immutable'
      : 'public, max-age=300';
  res.writeHead(200, {
    'Content-Type': contentTypes[ext] || 'application/octet-stream',
    'Cache-Control': cacheControl,
  });
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
