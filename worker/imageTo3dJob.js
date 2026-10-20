import { downloadProviderGlb, generateGlb, safeProviderError } from './imageTo3dProvider.js';

const MAX_INPUT_BYTES = 10 * 1024 * 1024;
const MAX_GLB_BYTES = 20 * 1024 * 1024;
const CHUNK_BYTES = 512 * 1024;
const MAX_JOB_MS = 10 * 60 * 1000;
const UNKNOWN_LEASE_MS = 20 * 60 * 1000;
const JOBS_PER_DAY = 2;
const TERMINAL_STATES = new Set(['completed', 'failed', 'unknown', 'cancelled']);

const json = (data, status = 200) => Response.json(data, {
  status,
  headers: { 'Cache-Control': 'no-store' },
});

const encode = (bytes) => btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');

const sha256 = async (value) => {
  const data = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};

export function validateImageBytes(bytes, mimeType) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > MAX_INPUT_BYTES) return false;
  if (mimeType === 'image/png') return bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, i) => bytes[i] === value);
  if (mimeType === 'image/jpeg') return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mimeType === 'image/webp') return bytes.length >= 12
    && String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF'
    && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP';
  return false;
}

export function validateGlbBytes(bytes) {
  return bytes instanceof Uint8Array && bytes.length >= 12 && bytes.length <= MAX_GLB_BYTES
    && bytes[0] === 0x67 && bytes[1] === 0x6c && bytes[2] === 0x54 && bytes[3] === 0x46
    && bytes[4] === 2;
}

function bind(db, sql, ...values) {
  return db.exec(sql, ...values);
}

function rows(db, sql, ...values) {
  return bind(db, sql, ...values).toArray();
}

function sanitizeInputName(value) {
  const name = String(value || 'input-image.png').replace(/[\\/\u0000-\u001f]/g, '_').slice(0, 100);
  return /\.(?:png|jpe?g|webp)$/i.test(name) ? name : 'input-image.png';
}

export class ImageTo3DJob {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    const db = ctx.storage.sql;
    bind(db, `CREATE TABLE IF NOT EXISTS image3d_jobs (
      id TEXT PRIMARY KEY,
      job_cap_hash TEXT NOT NULL,
      asset_cap_hash TEXT NOT NULL,
      state TEXT NOT NULL,
      phase TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deadline_at INTEGER NOT NULL,
      input_name TEXT NOT NULL,
      input_mime TEXT NOT NULL,
      input_bytes INTEGER NOT NULL,
      chunk_count INTEGER NOT NULL,
      submit_started INTEGER NOT NULL DEFAULT 0,
      provider_event_id TEXT,
      provider_session_hash TEXT,
      glb_key TEXT,
      glb_bytes INTEGER,
      error_code TEXT
    )`);
    bind(db, `CREATE TABLE IF NOT EXISTS image3d_input_chunks (
      job_id TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      bytes BLOB NOT NULL,
      PRIMARY KEY (job_id, chunk_index)
    )`);
    bind(db, 'CREATE INDEX IF NOT EXISTS image3d_jobs_created_idx ON image3d_jobs(created_at)');
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/create' && request.method === 'POST') return this.create(request);
    if (url.pathname === '/status' && request.method === 'GET') return this.status(url);
    if (url.pathname === '/cancel' && request.method === 'POST') return this.cancel(url);
    if (url.pathname === '/asset' && request.method === 'GET') return this.asset(url);
    return json({ error: 'NOT_FOUND' }, 404);
  }

  async create(request) {
    const id = request.headers.get('x-image3d-job-id') || '';
    const jobCapability = request.headers.get('x-image3d-job-cap') || '';
    const assetCapability = request.headers.get('x-image3d-asset-cap') || '';
    const mimeType = request.headers.get('x-image3d-input-mime') || '';
    const fileName = sanitizeInputName(request.headers.get('x-image3d-input-name') || 'input-image.png');
    if (!/^[0-9a-f-]{36}$/i.test(id) || jobCapability.length < 32 || assetCapability.length < 32) return json({ error: 'INVALID_REQUEST' }, 400);
    const db = this.ctx.storage.sql;
    const existing = rows(db, 'SELECT * FROM image3d_jobs WHERE id = ?', id)[0];
    const jobCapHash = await sha256(jobCapability);
    const assetCapHash = await sha256(assetCapability);
    if (existing) {
      if (existing.job_cap_hash !== jobCapHash || existing.asset_cap_hash !== assetCapHash) return json({ error: 'IDEMPOTENCY_CONFLICT' }, 409);
      return json(this.publicJob(existing));
    }
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (!validateImageBytes(bytes, mimeType)) return json({ error: 'INVALID_IMAGE' }, bytes.length > MAX_INPUT_BYTES ? 413 : 400);
    const now = Date.now();
    const active = rows(db, `SELECT id, state, updated_at FROM image3d_jobs
      WHERE state IN ('queued','running','submitting','processing')
         OR (state='unknown' AND updated_at > ?)
      LIMIT 1`, now - UNKNOWN_LEASE_MS)[0];
    if (active) return json({ error: 'JOB_ALREADY_ACTIVE', retryAt: active.updated_at + UNKNOWN_LEASE_MS }, 429);
    const count = rows(db, 'SELECT COUNT(*) AS count FROM image3d_jobs WHERE created_at >= ?', now - 24 * 60 * 60 * 1000)[0]?.count ?? 0;
    if (count >= JOBS_PER_DAY) return json({ error: 'DAILY_LIMIT_REACHED' }, 429);

    const chunkCount = Math.ceil(bytes.length / CHUNK_BYTES);
    bind(db, `INSERT INTO image3d_jobs
      (id, job_cap_hash, asset_cap_hash, state, phase, created_at, updated_at, deadline_at, input_name, input_mime, input_bytes, chunk_count)
      VALUES (?, ?, ?, 'storing-input', 'persisting-input', ?, ?, ?, ?, ?, ?, ?)`,
    id, jobCapHash, assetCapHash, now, now, now + MAX_JOB_MS, fileName, mimeType, bytes.length, chunkCount);
    for (let index = 0; index < chunkCount; index += 1) {
      bind(db, 'INSERT INTO image3d_input_chunks (job_id, chunk_index, bytes) VALUES (?, ?, ?)',
        id, index, bytes.slice(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES));
    }
    bind(db, "UPDATE image3d_jobs SET state='queued', phase='queued', updated_at=? WHERE id=?", Date.now(), id);
    try {
      await this.ctx.storage.setAlarm(Date.now() + 1000);
    } catch {
      bind(db, "UPDATE image3d_jobs SET state='failed', phase='failed', error_code='TASK_SCHEDULING_FAILED', updated_at=? WHERE id=?", Date.now(), id);
      bind(db, 'DELETE FROM image3d_input_chunks WHERE job_id=?', id);
      return json({ error: 'TASK_SCHEDULING_FAILED' }, 503);
    }
    return json(this.publicJob(rows(db, 'SELECT * FROM image3d_jobs WHERE id = ?', id)[0]), 202);
  }

  async status(url) {
    const job = rows(this.ctx.storage.sql, 'SELECT * FROM image3d_jobs WHERE id = ?', url.searchParams.get('id') || '')[0];
    if (!job || !(await this.matches(job.job_cap_hash, url.searchParams.get('cap')))) return json({ error: 'JOB_NOT_FOUND' }, 404);
    return json(this.publicJob(job));
  }

  async cancel(url) {
    const id = url.searchParams.get('id') || '';
    const job = rows(this.ctx.storage.sql, 'SELECT * FROM image3d_jobs WHERE id = ?', id)[0];
    if (!job || !(await this.matches(job.job_cap_hash, url.searchParams.get('cap')))) return json({ error: 'JOB_NOT_FOUND' }, 404);
    if (job.state !== 'queued') return json({ error: 'JOB_CANNOT_BE_CANCELLED' }, 409);
    bind(this.ctx.storage.sql, "UPDATE image3d_jobs SET state='cancelled', phase='cancelled', updated_at=? WHERE id=?", Date.now(), id);
    bind(this.ctx.storage.sql, 'DELETE FROM image3d_input_chunks WHERE job_id=?', id);
    return json({ state: 'cancelled' });
  }

  async asset(url) {
    const job = rows(this.ctx.storage.sql, 'SELECT * FROM image3d_jobs WHERE id = ?', url.searchParams.get('id') || '')[0];
    if (!job || job.state !== 'completed' || !(await this.matches(job.asset_cap_hash, url.searchParams.get('cap')))) {
      return json({ error: 'ASSET_NOT_FOUND' }, 404);
    }
    let object = null;
    for (const delay of [0, 120, 500]) {
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      object = await this.env.IMAGE_TO_3D_ASSETS.get(job.glb_key, 'arrayBuffer');
      if (object) break;
    }
    if (!object) return json({ error: 'ASSET_NOT_VISIBLE_YET' }, 503);
    return new Response(object, {
      headers: {
        'Content-Type': 'model/gltf-binary',
        'Content-Length': String(job.glb_bytes),
        'Cache-Control': 'private, max-age=300',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  }

  async matches(expectedHash, capability) {
    return typeof capability === 'string' && capability.length >= 32 && expectedHash === await sha256(capability);
  }

  publicJob(job) {
    return {
      id: job.id,
      state: job.state,
      phase: job.phase,
      createdAt: job.created_at,
      updatedAt: job.updated_at,
      deadlineAt: job.deadline_at,
      inputName: job.input_name,
      ...(job.glb_bytes ? { glbBytes: job.glb_bytes } : {}),
      ...(job.error_code ? { error: job.error_code } : {}),
    };
  }

  async alarm() {
    const db = this.ctx.storage.sql;
    let job = rows(db, "SELECT * FROM image3d_jobs WHERE state='queued' ORDER BY created_at LIMIT 1")[0];
    if (!job) {
      job = rows(db, "SELECT * FROM image3d_jobs WHERE state IN ('running','submitting','processing') ORDER BY created_at LIMIT 1")[0];
      if (job) {
        const state = job.submit_started ? 'unknown' : 'failed';
        const phase = job.submit_started ? 'submission-uncertain' : (job.phase || 'connecting');
        const error = job.submit_started ? 'SUBMISSION_STATUS_UNKNOWN' : 'PREPROCESS_INTERRUPTED';
        bind(db, 'UPDATE image3d_jobs SET state=?, phase=?, error_code=?, updated_at=? WHERE id=?', state, phase, error, Date.now(), job.id);
        bind(db, 'DELETE FROM image3d_input_chunks WHERE job_id=?', job.id);
      }
      return;
    }
    if (job.chunk_count <= 0 || job.input_bytes <= 0 || Date.now() >= job.deadline_at) {
      bind(db, "UPDATE image3d_jobs SET state='failed', phase='failed', error_code='INPUT_UNAVAILABLE', updated_at=? WHERE id=?", Date.now(), job.id);
      return;
    }
    const chunks = rows(db, 'SELECT bytes FROM image3d_input_chunks WHERE job_id=? ORDER BY chunk_index', job.id);
    if (chunks.length !== job.chunk_count) {
      bind(db, "UPDATE image3d_jobs SET state='failed', phase='failed', error_code='INPUT_UNAVAILABLE', updated_at=? WHERE id=?", Date.now(), job.id);
      return;
    }
    const image = new Uint8Array(job.input_bytes);
    let offset = 0;
    for (const chunk of chunks) {
      image.set(new Uint8Array(chunk.bytes), offset);
      offset += chunk.bytes.byteLength;
    }
    if (!validateImageBytes(image, job.input_mime)) {
      bind(db, "UPDATE image3d_jobs SET state='failed', phase='failed', error_code='INPUT_UNAVAILABLE', updated_at=? WHERE id=?", Date.now(), job.id);
      return;
    }
    if (!this.env.HF_TOKEN) {
      this.fail(job.id, 'PROVIDER_NOT_CONFIGURED');
      return;
    }
    const configuredTokenExpiry = this.env.HF_TOKEN_EXPIRES_AT ? Date.parse(this.env.HF_TOKEN_EXPIRES_AT) : NaN;
    if (Number.isFinite(configuredTokenExpiry) && Date.now() >= configuredTokenExpiry) {
      this.fail(job.id, 'PROVIDER_AUTH_UPDATE_REQUIRED');
      return;
    }

    bind(db, "UPDATE image3d_jobs SET state='running', phase='connecting', updated_at=? WHERE id=?", Date.now(), job.id);
    let client = null;
    let providerResultReceived = false;
    let timedOut = false;
    let timeoutId;
    const isActive = () => {
      const current = rows(db, 'SELECT state, deadline_at FROM image3d_jobs WHERE id=?', job.id)[0];
      return current && ['running', 'submitting', 'processing'].includes(current.state) && Date.now() < current.deadline_at;
    };
    try {
      const timeout = new Promise((_, reject) => { timeoutId = setTimeout(() => {
        timedOut = true;
        client?.close();
        const error = new Error('PROVIDER_TIMEOUT');
        error.submissionUncertain = true;
        reject(error);
      }, Math.min(MAX_JOB_MS, job.deadline_at - Date.now())); });
      const generation = (async () => {
        const generated = await generateGlb({
          token: this.env.HF_TOKEN,
          bytes: image,
          fileName: job.input_name,
          mimeType: job.input_mime,
          onConnected: (connectedClient) => {
            if (timedOut || !isActive()) connectedClient.close();
            else client = connectedClient;
          },
          onPhase: (phase) => {
            if (isActive()) bind(db, 'UPDATE image3d_jobs SET phase=?, updated_at=? WHERE id=?', phase, Date.now(), job.id);
          },
          onSubmitStarting: () => {
            const current = rows(db, 'SELECT state, deadline_at FROM image3d_jobs WHERE id=?', job.id)[0];
            if (timedOut || current?.state !== 'running' || Date.now() >= current.deadline_at) return false;
            bind(db, "UPDATE image3d_jobs SET state='submitting', phase='submitting', submit_started=1, updated_at=? WHERE id=?",
              Date.now(), job.id);
            return true;
          },
          onSubmitted: ({ eventId, sessionHash }) => {
            const current = rows(db, 'SELECT state, deadline_at FROM image3d_jobs WHERE id=?', job.id)[0];
            if (timedOut || current?.state !== 'submitting' || Date.now() >= current.deadline_at) return false;
            bind(db, "UPDATE image3d_jobs SET state='processing', phase='processing', provider_event_id=?, provider_session_hash=?, updated_at=? WHERE id=?",
              eventId, sessionHash || null, Date.now(), job.id);
            return true;
          },
          onProgress: ({ stage }) => {
            if (isActive()) bind(db, "UPDATE image3d_jobs SET phase=?, updated_at=? WHERE id=?",
              stage === 'pending' ? 'waiting-in-queue' : 'generating', Date.now(), job.id);
          },
        });
        providerResultReceived = true;
        client = generated.client;
        if (timedOut || !isActive()) return;
        bind(db, "UPDATE image3d_jobs SET phase='saving-result', updated_at=? WHERE id=?", Date.now(), job.id);
        const glbBytes = await downloadProviderGlb(client, generated.file, MAX_GLB_BYTES);
        if (!validateGlbBytes(glbBytes)) throw new Error('PROVIDER_RESULT_INVALID');
        if (timedOut || !isActive()) return;
        if (Date.now() >= job.deadline_at) throw new Error('PROVIDER_TIMEOUT');
        const key = `generated/${job.id}.glb`;
        await this.env.IMAGE_TO_3D_ASSETS.put(key, glbBytes, {
          metadata: { jobId: job.id, contentType: 'model/gltf-binary' },
        });
        if (timedOut || !isActive()) {
          await this.env.IMAGE_TO_3D_ASSETS.delete(key);
          return;
        }
        bind(db, "UPDATE image3d_jobs SET state='completed', phase='completed', glb_key=?, glb_bytes=?, error_code=NULL, updated_at=? WHERE id=?",
          key, glbBytes.byteLength, Date.now(), job.id);
        bind(db, 'DELETE FROM image3d_input_chunks WHERE job_id=?', job.id);
      })();
      await Promise.race([generation, timeout]);
    } catch (error) {
      const current = rows(db, 'SELECT * FROM image3d_jobs WHERE id=?', job.id)[0];
      if (!TERMINAL_STATES.has(current?.state)) {
        const errorCode = safeProviderError(error);
        const uncertain = Boolean(current?.submit_started && !providerResultReceived && error?.submissionUncertain && !error?.definitive);
        const state = uncertain ? 'unknown' : 'failed';
        bind(db, 'UPDATE image3d_jobs SET state=?, phase=?, error_code=?, updated_at=? WHERE id=?',
          state, uncertain ? 'submission-uncertain' : (current?.phase || 'failed'), uncertain ? 'SUBMISSION_STATUS_UNKNOWN' : errorCode, Date.now(), job.id);
        bind(db, 'DELETE FROM image3d_input_chunks WHERE job_id=?', job.id);
      }
    } finally {
      clearTimeout(timeoutId);
      client?.close();
      image.fill(0);
    }
  }

  fail(id, code) {
    bind(this.ctx.storage.sql, "UPDATE image3d_jobs SET state='failed', error_code=?, updated_at=? WHERE id=?", code, Date.now(), id);
    bind(this.ctx.storage.sql, 'DELETE FROM image3d_input_chunks WHERE job_id=?', id);
  }
}

export async function handleImageTo3dRequest({ request, env }, requireAuth) {
  if (!env.IMAGE_TO_3D_JOBS || !env.IMAGE_TO_3D_ASSETS) return json({ error: 'IMAGE_TO_3D_NOT_CONFIGURED' }, 503);
  const url = new URL(request.url);
  const match = url.pathname.match(/^\/api\/image-to-3d\/jobs(?:\/([0-9a-f-]{36})(?:\/(asset|cancel))?)?$/i);
  if (!match) return json({ error: 'NOT_FOUND' }, 404);
  const [, id, action] = match;
  if (!(action === 'asset' && request.method === 'GET') && !(await requireAuth(request, env))) return json({ error: 'UNAUTHORIZED' }, 401);
  const stub = env.IMAGE_TO_3D_JOBS.get(env.IMAGE_TO_3D_JOBS.idFromName('personal-image-to-3d'));
  if (request.method === 'POST' && !id) {
    const accessKey = request.headers.get('X-Image-To-3D-Access-Key') || '';
    if (!env.IMAGE_TO_3D_ACCESS_KEY) return json({ error: 'IMAGE_TO_3D_ACCESS_NOT_CONFIGURED' }, 503);
    if (accessKey.length !== env.IMAGE_TO_3D_ACCESS_KEY.length || !constantTimeEqual(accessKey, env.IMAGE_TO_3D_ACCESS_KEY)) {
      return json({ error: 'IMAGE_TO_3D_ACCESS_DENIED' }, 403);
    }
    const jobId = request.headers.get('X-Image-To-3D-Job-Id') || '';
    const jobCapability = request.headers.get('X-Image-To-3D-Job-Capability') || '';
    const assetCapability = request.headers.get('X-Image-To-3D-Asset-Capability') || '';
    if (!/^[0-9a-f-]{36}$/i.test(jobId) || jobCapability.length < 32 || assetCapability.length < 32) return json({ error: 'INVALID_REQUEST' }, 400);
    const contentLength = Number(request.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > MAX_INPUT_BYTES + 128 * 1024) return json({ error: 'IMAGE_TOO_LARGE' }, 413);
    const multipartBytes = await readBoundedRequest(request, MAX_INPUT_BYTES + 128 * 1024);
    if (!multipartBytes) return json({ error: 'IMAGE_TOO_LARGE' }, 413);
    const formRequest = new Request(request.url, { method: 'POST', headers: request.headers, body: multipartBytes });
    const form = await formRequest.formData().catch(() => null);
    const file = form?.get('image');
    if (!(file instanceof File)) return json({ error: 'IMAGE_REQUIRED' }, 400);
    if (file.size > MAX_INPUT_BYTES) return json({ error: 'IMAGE_TOO_LARGE' }, 413);
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!validateImageBytes(bytes, file.type)) return json({ error: 'INVALID_IMAGE' }, 400);
    const safeInputName = String(file.name || 'input-image.png').replace(/[\\/\u0000-\u001f]/g, '_').slice(0, 100);
    const headers = {
      'X-Image3D-Job-Id': jobId,
      'X-Image3D-Job-Cap': jobCapability,
      'X-Image3D-Asset-Cap': assetCapability,
      'X-Image3D-Input-Mime': file.type,
      'X-Image3D-Input-Name': safeInputName,
    };
    const result = await stub.fetch(new Request('https://image-to-3d.internal/create', { method: 'POST', headers, body: bytes }));
    const payload = await result.json();
    if (result.ok) payload.assetUrl = `/api/image-to-3d/jobs/${jobId}/asset?cap=${encodeURIComponent(assetCapability)}`;
    return json(payload, result.status);
  }
  if (!id) return json({ error: 'METHOD_NOT_ALLOWED' }, 405);
  const capability = url.searchParams.get('cap') || '';
  if (action === 'asset' && request.method === 'GET') {
    return stub.fetch(new Request(`https://image-to-3d.internal/asset?id=${id}&cap=${encodeURIComponent(capability)}`));
  }
  if (action === 'cancel' && request.method === 'POST') {
    return stub.fetch(new Request(`https://image-to-3d.internal/cancel?id=${id}&cap=${encodeURIComponent(capability)}`, { method: 'POST' }));
  }
  if (!action && request.method === 'GET') {
    return stub.fetch(new Request(`https://image-to-3d.internal/status?id=${id}&cap=${encodeURIComponent(capability)}`));
  }
  return json({ error: 'METHOD_NOT_ALLOWED' }, 405);
}

async function readBoundedRequest(request, limit) {
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function constantTimeEqual(left, right) {
  let mismatch = left.length ^ right.length;
  const limit = Math.max(left.length, right.length);
  for (let index = 0; index < limit; index += 1) mismatch |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  return mismatch === 0;
}
