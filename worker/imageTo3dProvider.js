import { Client } from '@gradio/client';

const SPACE = 'trellis-community/TRELLIS';
const ENDPOINT = '/generate_and_extract_glb';

export function safeProviderError(error) {
  const status = Number(error?.status ?? error?.statusCode);
  if (status === 401 || status === 403) return 'PROVIDER_AUTH_FAILED';
  if (status === 429) return 'PROVIDER_CAPACITY_LIMIT';
  if (status === 402) return 'PROVIDER_QUOTA_EXHAUSTED';
  if (error?.name === 'AbortError') return 'PROVIDER_TIMEOUT';
  const safeCodes = new Set([
    'PROVIDER_SESSION_FAILED', 'PROVIDER_PREPROCESS_FAILED', 'PROVIDER_SUBMISSION_UNCONFIRMED', 'PROVIDER_QUOTA_EXHAUSTED',
    'PROVIDER_AUTH_FAILED', 'PROVIDER_AUTH_UPDATE_REQUIRED', 'PROVIDER_CAPACITY_LIMIT',
    'PROVIDER_JOB_FAILED', 'PROVIDER_RESULT_MISSING_GLB', 'PROVIDER_RESULT_INVALID',
    'PROVIDER_RESULT_DOWNLOAD_FAILED', 'PROVIDER_RESULT_TOO_LARGE', 'PROVIDER_TIMEOUT',
  ]);
  if (safeCodes.has(error?.message)) return error.message;
  return 'PROVIDER_FAILED';
}

function providerStatusError(event) {
  const providerMessage = typeof event?.message === 'string' ? event.message.toLowerCase() : '';
  const providerCode = typeof event?.code === 'string' ? event.code.toLowerCase() : '';
  const signal = `${providerCode} ${providerMessage}`;
  if (event?.broken === true || /broken[_ -]connection|connection[_ -](?:error|lost|reset|closed)|network[_ -]error/.test(signal)) {
    const error = new Error('PROVIDER_CONNECTION_INTERRUPTED');
    error.submissionUncertain = true;
    return error;
  }
  if (event?.session_not_found === true) {
    const error = new Error('PROVIDER_SUBMISSION_UNCONFIRMED');
    error.submissionUncertain = true;
    return error;
  }
  if (/quota|gpu hours?|credits?/.test(signal) && /exhaust|insufficient|not enough|exceed|limit|no more|unavailable/.test(signal)) {
    return definitiveProviderError('PROVIDER_QUOTA_EXHAUSTED');
  }
  if (/\b401\b|unauthori[sz]ed|authentication failed|invalid (?:access )?token|token expired/.test(signal)) {
    return definitiveProviderError('PROVIDER_AUTH_FAILED');
  }
  if (/queue[_ -]full|capacity[_ -](?:limit|exceeded)|too many requests/.test(signal)) {
    return definitiveProviderError('PROVIDER_CAPACITY_LIMIT');
  }
  return definitiveProviderError('PROVIDER_JOB_FAILED');
}

function definitiveProviderError(code) {
  const error = new Error(code);
  error.definitive = true;
  return error;
}

function isDefinitiveRejection(error) {
  const status = Number(error?.status ?? error?.statusCode);
  return [400, 401, 402, 403, 404, 413, 422, 429].includes(status);
}

export function findGlbFile(value) {
  if (!value) return null;
  if (typeof value === 'string' && /\.glb(?:$|[?#])/i.test(value)) return { path: value };
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findGlbFile(item);
      if (found) return found;
    }
    return null;
  }
  if (typeof value !== 'object') return null;
  const candidatePath = [value.path, value.url, value.orig_name, value.name]
    .find((entry) => typeof entry === 'string' && /\.glb(?:$|[?#])/i.test(entry));
  if (candidatePath) return value;
  for (const nested of Object.values(value)) {
    const found = findGlbFile(nested);
    if (found) return found;
  }
  return null;
}

function findProviderFile(value) {
  if (!value) return null;
  if (typeof value === 'string') return { path: value };
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findProviderFile(item);
      if (found) return found;
    }
    return null;
  }
  if (typeof value !== 'object') return null;
  if (typeof value.url === 'string' || typeof value.path === 'string') return value;
  for (const nested of Object.values(value)) {
    const found = findProviderFile(nested);
    if (found) return found;
  }
  return null;
}

export async function generateGlb({ token, bytes, fileName, mimeType, connect = Client.connect, onConnected, onPhase, onSubmitStarting, onSubmitted, onProgress }) {
  const client = await connect(SPACE, { token, events: ['status', 'data'] });
  let submissionStarted = false;
  onConnected?.(client);
  let submissionCompleted = false;
  try {
    // The Space's Python workflow explicitly starts a session before generation.
    const session = client.submit('/start_session', {});
    for await (const event of session) {
      if (event.type === 'status' && event.stage === 'error') throw new Error('PROVIDER_SESSION_FAILED');
    }

    onPhase?.('preprocessing');
    const uploadedImage = new File([bytes], fileName, { type: mimeType });
    const preprocessed = await client.predict('/preprocess_image', { image: uploadedImage });
    const preprocessedFile = findProviderFile(preprocessed?.data);
    if (!preprocessedFile) throw new Error('PROVIDER_PREPROCESS_FAILED');
    const preprocessedBytes = await downloadProviderFile(client, preprocessedFile, 10 * 1024 * 1024);
    const image = new File([preprocessedBytes], 'preprocessed-input.png', { type: 'image/png' });

    onPhase?.('submitting');
    const permit = onSubmitStarting?.();
    if (permit === false) throw definitiveProviderError('JOB_NO_LONGER_ACTIVE');
    if (permit && typeof permit.then === 'function' && await permit === false) throw definitiveProviderError('JOB_NO_LONGER_ACTIVE');
    submissionStarted = true;
    const submission = client.submit(ENDPOINT, {
      image,
      multiimages: [],
      seed: 0,
      ss_guidance_strength: 7.5,
      ss_sampling_steps: 12,
      slat_guidance_strength: 3,
      slat_sampling_steps: 12,
      multiimage_algo: 'stochastic',
      mesh_simplify: 0.95,
      texture_size: 1024,
    });
    const eventId = await submission.wait_for_id();
    if (!eventId) throw new Error('PROVIDER_SUBMISSION_UNCONFIRMED');
    const persisted = await onSubmitted?.({ eventId, sessionHash: client.session_hash });
    if (persisted === false) throw definitiveProviderError('JOB_NO_LONGER_ACTIVE');

    let result = null;
    for await (const event of submission) {
      if (event.type === 'status') {
        onProgress?.({ stage: event.stage, queuePosition: event.position ?? null });
        if (event.stage === 'error' || event.success === false) throw providerStatusError(event);
      }
      if (event.type === 'data') result = event.data;
    }
    submissionCompleted = true;
    const glb = findGlbFile(result);
    if (!glb) throw definitiveProviderError('PROVIDER_RESULT_MISSING_GLB');
    return { client, file: glb };
  } catch (error) {
    client.close();
    if (submissionStarted && !submissionCompleted && !error?.definitive) {
      error.submissionUncertain = !isDefinitiveRejection(error);
      if (!error.submissionUncertain) error.definitive = true;
    }
    throw error;
  }
}

export async function downloadProviderGlb(client, file, maxBytes) {
  try {
    return await downloadProviderFile(client, file, maxBytes);
  } catch (error) {
    error.definitive = true;
    throw error;
  }
}

async function downloadProviderFile(client, file, maxBytes) {
  const root = client.config?.root;
  if (typeof root !== 'string') throw new Error('PROVIDER_RESULT_INVALID');
  const candidate = typeof file.url === 'string' ? file.url : file.path;
  if (typeof candidate !== 'string' || !candidate) throw new Error('PROVIDER_RESULT_INVALID');
  const url = new URL(candidate, root);
  if (url.origin !== new URL(root).origin) throw new Error('PROVIDER_RESULT_INVALID');
  const response = await client.fetch(url, { redirect: 'manual' });
  if (response.status >= 300 && response.status < 400) throw new Error('PROVIDER_RESULT_INVALID');
  if (response.url && new URL(response.url).origin !== new URL(root).origin) throw new Error('PROVIDER_RESULT_INVALID');
  if (!response.ok) throw new Error('PROVIDER_RESULT_DOWNLOAD_FAILED');
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > maxBytes) throw new Error('PROVIDER_RESULT_TOO_LARGE');
  const reader = response.body?.getReader();
  if (!reader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new Error('PROVIDER_RESULT_TOO_LARGE');
    return bytes;
  }
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error('PROVIDER_RESULT_TOO_LARGE');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
