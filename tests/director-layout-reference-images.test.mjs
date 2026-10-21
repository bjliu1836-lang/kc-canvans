import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildDirectorLayoutImageContent,
  DIRECTOR_LAYOUT_MAX_INLINE_IMAGE_CHARS,
  normalizeDirectorLayoutReferenceImages,
} from '../functions/shared/director-layout-observations.js';

const image = (id, role = 'supplementary', url = `data:image/png;base64,${id}`) => ({ id, sourceId: id, role, url });

test('reference image contract accepts one to three ordered images and keeps the legacy single-image request', () => {
  const legacy = normalizeDirectorLayoutReferenceImages({ image: { sourceId: 'legacy', url: 'https://example.test/room.png' } });
  assert.deepEqual(legacy, [{ id: 'legacy', role: 'primary', sourceId: 'legacy', url: 'https://example.test/room.png' }]);

  const group = normalizeDirectorLayoutReferenceImages({ images: [
    image('main', 'primary'), image('side'), image('detail'),
  ] });
  assert.deepEqual(group.map(({ id, role }) => ({ id, role })), [
    { id: 'main', role: 'primary' }, { id: 'side', role: 'supplementary' }, { id: 'detail', role: 'supplementary' },
  ]);
  const content = buildDirectorLayoutImageContent(group, '融合为一份观察');
  assert.equal(content.filter((part) => part.type === 'image_url').length, 3);
  assert.equal(content.at(-1).text, '融合为一份观察');
  assert.match(content[0].text, /唯一二维坐标基准/);
  assert.match(content[2].text, /不可直接使用本图像素坐标/);
});

test('reference image contract rejects empty, over-limit, invalid order, duplicate identity and ambiguous legacy fields', () => {
  assert.throws(() => normalizeDirectorLayoutReferenceImages({}), /DIRECTOR_LAYOUT_IMAGE_REQUIRED/);
  assert.throws(() => normalizeDirectorLayoutReferenceImages({ images: [] }), /DIRECTOR_LAYOUT_IMAGES_INVALID/);
  assert.throws(() => normalizeDirectorLayoutReferenceImages({ images: [image('a', 'primary'), image('b'), image('c'), image('d')] }), /DIRECTOR_LAYOUT_TOO_MANY_IMAGES/);
  assert.throws(() => normalizeDirectorLayoutReferenceImages({ images: [image('a')] }), /DIRECTOR_LAYOUT_IMAGES_INVALID/);
  assert.throws(() => normalizeDirectorLayoutReferenceImages({ images: [image('a', 'primary'), image('a')] }), /DIRECTOR_LAYOUT_IMAGES_INVALID/);
  assert.throws(() => normalizeDirectorLayoutReferenceImages({ images: [image('a', 'primary')], image: { url: 'data:image/png;base64,AA==' } }), /DIRECTOR_LAYOUT_IMAGES_AMBIGUOUS/);
  assert.throws(() => normalizeDirectorLayoutReferenceImages({ images: [{ id: 'a', role: 'primary', url: 'file:///room.png' }] }), /DIRECTOR_LAYOUT_IMAGES_INVALID/);
  assert.throws(() => normalizeDirectorLayoutReferenceImages({ image: { url: `data:image/png;base64,${'A'.repeat(DIRECTOR_LAYOUT_MAX_INLINE_IMAGE_CHARS + 1)}` } }), /DIRECTOR_LAYOUT_IMAGE_TOO_LARGE/);
  assert.throws(() => normalizeDirectorLayoutReferenceImages({ images: [
    image('a', 'primary', `data:image/png;base64,${'A'.repeat(8.5 * 1024 * 1024)}`),
    image('b', 'supplementary', `data:image/png;base64,${'A'.repeat(8.5 * 1024 * 1024)}`),
  ] }), /DIRECTOR_LAYOUT_IMAGES_TOO_LARGE/);
});
