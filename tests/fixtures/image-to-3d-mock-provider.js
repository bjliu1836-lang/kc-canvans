function makeMockGlb() {
  const positions = new Float32Array([-0.5, 0, -0.5, 0.5, 0, -0.5, 0, 1, 0.5]);
  const document = {
    asset: { version: '2.0', generator: 'local mock fixture' },
    buffers: [{ byteLength: positions.byteLength }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: positions.byteLength, target: 34962 }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [-0.5, 0, -0.5], max: [0.5, 1, 0.5] }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, mode: 4 }] }],
    nodes: [{ mesh: 0 }],
    scenes: [{ nodes: [0] }],
    scene: 0,
  };
  const encoder = new TextEncoder();
  const json = encoder.encode(JSON.stringify(document));
  const jsonLength = (json.byteLength + 3) & ~3;
  const binaryLength = (positions.byteLength + 3) & ~3;
  const totalLength = 12 + 8 + jsonLength + 8 + binaryLength;
  const glb = new Uint8Array(totalLength);
  const view = new DataView(glb.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, totalLength, true);
  view.setUint32(12, jsonLength, true);
  view.setUint32(16, 0x4e4f534a, true);
  glb.fill(0x20, 20, 20 + jsonLength);
  glb.set(json, 20);
  const binaryHeader = 20 + jsonLength;
  view.setUint32(binaryHeader, binaryLength, true);
  view.setUint32(binaryHeader + 4, 0x004e4942, true);
  glb.set(new Uint8Array(positions.buffer), binaryHeader + 8);
  return glb;
}

export const MOCK_GLB = makeMockGlb();

export function safeProviderError(error) {
  return ['PROVIDER_RESULT_TOO_LARGE', 'PROVIDER_RESULT_INVALID', 'PROVIDER_QUOTA_EXHAUSTED'].includes(error?.message)
    ? error.message
    : error?.providerPhase === 'connecting' ? 'PROVIDER_CONNECT_FAILED'
    : 'PROVIDER_FAILED';
}

export async function generateGlb({ fileName, onConnected, onPhase, onSubmitStarting, onSubmitted, onProgress }) {
  if (fileName === 'connect-error.png') {
    const error = new TypeError('mock connection failure');
    error.providerPhase = 'connecting';
    throw error;
  }
  const client = { close() {} };
  onConnected?.(client);
  onPhase?.('preprocessing');
  const maySubmit = onSubmitStarting?.();
  if (maySubmit === false) throw Object.assign(new Error('JOB_NO_LONGER_ACTIVE'), { definitive: true });
  onPhase?.('submitting');
  if (fileName === 'known-error.png') {
    throw Object.assign(new Error('PROVIDER_QUOTA_EXHAUSTED'), { definitive: true });
  }
  if (fileName === 'uncertain-error.png') {
    throw Object.assign(new Error('mock network interruption'), { submissionUncertain: true });
  }
  if (fileName === 'invalid-output.png') {
    await onSubmitted?.({ eventId: 'mock-provider-event', sessionHash: 'mock-provider-session' });
    return { client, file: { path: '/invalid-output.glb' } };
  }
  await onSubmitted?.({ eventId: 'mock-provider-event', sessionHash: 'mock-provider-session' });
  onProgress?.({ stage: 'pending' });
  onProgress?.({ stage: 'generating' });
  if (fileName === 'slow-chair.png') await new Promise((resolve) => setTimeout(resolve, 6000));
  return { client, file: { path: '/mock-output.glb' } };
}

export async function downloadProviderGlb(_client, file) {
  if (file.path === '/invalid-output.glb') return new Uint8Array([1, 2, 3]);
  return MOCK_GLB.slice();
}
