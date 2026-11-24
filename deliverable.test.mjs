import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDeliverable, openDeliverable, parsePreview, maxBundleBytes } from './lib/deliverable.ts';
import { encryptResult, decryptResult } from './lib/crypto.ts';

const encode = (value) => new TextEncoder().encode(value);
const input = (overrides = {}) => ({
  title: 'Audit', seller: 'Studio', description: 'd', sample: 's', note: 'private note',
  files: [
    { name: 'report.md', type: 'text/markdown', bytes: encode('# Report') },
    { name: 'data.bin', type: '', bytes: Uint8Array.from([0, 1, 2, 255]) },
  ],
  ...overrides,
});

test('preview lists every file with a SHA-256 hash and never contains file data or the note', async () => {
  const { preview, plaintext } = await buildDeliverable(input());
  assert.equal(preview.files.length, 2);
  assert.match(preview.files[0].sha256, /^[0-9a-f]{64}$/);
  assert.equal(preview.files[1].type, 'application/octet-stream');
  const publicText = JSON.stringify(preview);
  assert.ok(!publicText.includes('private note'));
  assert.ok(!('data' in preview.files[0]));
  assert.ok(plaintext.includes('private note'));
});

test('encrypt, decrypt with the key, and verify files against the preview (binary included)', async () => {
  const { preview, plaintext } = await buildDeliverable(input());
  const { key, payload } = await encryptResult(plaintext);
  const opened = await openDeliverable(await decryptResult(payload, key), preview);
  assert.equal(opened.allMatch, true);
  assert.equal(opened.note, 'private note');
  assert.deepEqual([...opened.files[1].bytes], [0, 1, 2, 255]);
  assert.equal(opened.files[0].text, '# Report');
});

test('the wrong key cannot open the deliverable', async () => {
  const { plaintext } = await buildDeliverable(input());
  const { payload } = await encryptResult(plaintext);
  const wrong = `0x${'ab'.repeat(32)}`;
  await assert.rejects(decryptResult(payload, wrong));
});

test('a file that differs from its previewed hash is flagged', async () => {
  const honest = await buildDeliverable(input());
  const swapped = await buildDeliverable(input({
    files: [
      { name: 'report.md', type: 'text/markdown', bytes: encode('# Something else') },
      { name: 'data.bin', type: '', bytes: Uint8Array.from([0, 1, 2, 255]) },
    ],
  }));
  const opened = await openDeliverable(swapped.plaintext, honest.preview);
  assert.equal(opened.allMatch, false);
  assert.deepEqual(opened.files.map((file) => file.matchesPreview), [false, true]);
});

test('a promised file that is missing from the bundle is reported', async () => {
  const full = await buildDeliverable(input());
  const partial = await buildDeliverable(input({ files: [input().files[0]] }));
  const opened = await openDeliverable(partial.plaintext, full.preview);
  assert.equal(opened.allMatch, false);
  assert.deepEqual(opened.missing, ['data.bin']);
});

test('building rejects empty, oversized, duplicate, and untitled deliverables', async () => {
  await assert.rejects(buildDeliverable(input({ files: [] })), /at least one file/);
  await assert.rejects(buildDeliverable(input({ title: '  ' })), /title/);
  await assert.rejects(buildDeliverable(input({ files: [{ name: 'big.bin', type: '', bytes: new Uint8Array(maxBundleBytes + 1) }] })), /limit/);
  const dup = { name: 'a.txt', type: 'text/plain', bytes: encode('x') };
  await assert.rejects(buildDeliverable(input({ files: [dup, dup] })), /Two files/);
});

test('file names cannot carry path separators', async () => {
  const { preview } = await buildDeliverable(input({ files: [{ name: '../../etc/passwd', type: '', bytes: encode('x') }] }));
  assert.ok(!preview.files[0].name.includes('/'));
});

test('an untrusted preview is validated', async () => {
  const { preview } = await buildDeliverable(input());
  assert.deepEqual(parsePreview(JSON.parse(JSON.stringify(preview))), preview);
  assert.throws(() => parsePreview(undefined), /missing/);
  assert.throws(() => parsePreview({ ...preview, files: [] }), /between 1 and 8/);
  assert.throws(() => parsePreview({ ...preview, files: [{ ...preview.files[0], sha256: 'zz' }] }), /SHA-256/);
  assert.throws(() => parsePreview({ ...preview, title: 'x'.repeat(500) }), /too long/);
});
