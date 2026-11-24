// A "deliverable" is what a freelancer hands over: one or more files plus a private note.
// The files are encrypted. A public preview (title, description, free sample, and a hash
// manifest of every file) travels with the offer so the client knows what they are buying
// and can check, after unlocking, that they received exactly that.

export const maxBundleBytes = 100 * 1024; // keeps the copy-and-paste offer JSON manageable
export const maxFiles = 8;

export type PreviewFile = { name: string; type: string; size: number; sha256: string };

export type OfferPreview = {
  title: string;
  seller: string;
  description: string;
  sample: string;
  files: PreviewFile[];
};

export type DeliverableInput = {
  title: string;
  seller: string;
  description: string;
  sample: string;
  note: string;
  files: { name: string; type: string; bytes: Uint8Array }[];
};

export type OpenedFile = PreviewFile & {
  bytes: Uint8Array;
  matchesPreview: boolean;
  text?: string;
};

export type OpenedDeliverable = {
  note: string;
  files: OpenedFile[];
  missing: string[];
  allMatch: boolean;
};

export const formatBytes = (size: number) =>
  size < 1024 ? `${size} B` : `${(size / 1024).toFixed(1)} KB`;

export async function sha256Hex(bytes: Uint8Array) {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('');
}

function toBase64(bytes: Uint8Array) {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

function fromBase64(value: string) {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function safeFileName(name: string) {
  const cleaned = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().slice(0, 120);
  if (!cleaned || /^\.+$/.test(cleaned)) throw new Error('A file has an unusable name.');
  return cleaned;
}

export async function buildDeliverable(input: DeliverableInput) {
  const title = input.title.trim();
  if (!title) throw new Error('Give the deliverable a title.');
  if (input.files.length === 0) throw new Error('Add at least one file to deliver.');
  if (input.files.length > maxFiles) throw new Error(`The demo accepts at most ${maxFiles} files.`);
  const total = input.files.reduce((sum, file) => sum + file.bytes.length, 0);
  if (total > maxBundleBytes) {
    throw new Error(`Files total ${formatBytes(total)}. The demo limit is ${formatBytes(maxBundleBytes)}.`);
  }

  const seen = new Set<string>();
  const delivered: (PreviewFile & { data: string })[] = [];
  for (const file of input.files) {
    const name = safeFileName(file.name);
    if (seen.has(name)) throw new Error(`Two files are named "${name}".`);
    seen.add(name);
    delivered.push({
      name,
      type: file.type || 'application/octet-stream',
      size: file.bytes.length,
      sha256: await sha256Hex(file.bytes),
      data: toBase64(file.bytes),
    });
  }

  const preview: OfferPreview = {
    title,
    seller: input.seller.trim(),
    description: input.description.trim(),
    sample: input.sample.trim(),
    files: delivered.map(({ name, type, size, sha256 }) => ({ name, type, size, sha256 })),
  };
  const plaintext = JSON.stringify({ note: input.note.trim(), files: delivered });
  return { preview, plaintext };
}

type JsonObject = Record<string, unknown>;
const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function text(value: unknown, label: string, max: number, required = false) {
  if (value === undefined && !required) return '';
  if (typeof value !== 'string') throw new Error(`${label} is missing.`);
  const trimmed = value.trim();
  if (required && !trimmed) throw new Error(`${label} is missing.`);
  if (trimmed.length > max) throw new Error(`${label} is too long.`);
  return trimmed;
}

// The preview comes from the seller's offer JSON, so treat it as untrusted input.
export function parsePreview(value: unknown): OfferPreview {
  if (!isObject(value)) throw new Error('Offer preview is missing.');
  if (!Array.isArray(value.files) || value.files.length === 0 || value.files.length > maxFiles) {
    throw new Error('Offer preview must list between 1 and 8 files.');
  }
  const files = value.files.map((entry: unknown): PreviewFile => {
    if (!isObject(entry)) throw new Error('A file in the preview is malformed.');
    const size = entry.size;
    if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0 || size > maxBundleBytes) {
      throw new Error('A file in the preview has an invalid size.');
    }
    const sha256 = text(entry.sha256, 'File hash', 64, true).toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error('A file hash in the preview is not SHA-256.');
    return {
      name: safeFileName(text(entry.name, 'File name', 120, true)),
      type: text(entry.type, 'File type', 100, true),
      size,
      sha256,
    };
  });
  return {
    title: text(value.title, 'Preview title', 120, true),
    seller: text(value.seller, 'Seller name', 80),
    description: text(value.description, 'Preview description', 600),
    sample: text(value.sample, 'Free sample', 2000),
    files,
  };
}

const textLike = (file: PreviewFile) =>
  file.type.startsWith('text/') || /\.(md|txt|csv|json)$/i.test(file.name);

// Open a decrypted bundle and compare every file with the hashes the client saw before paying.
export async function openDeliverable(plaintext: string, preview: OfferPreview): Promise<OpenedDeliverable> {
  const raw: unknown = JSON.parse(plaintext);
  if (!isObject(raw) || !Array.isArray(raw.files)) throw new Error('The unlocked content is not a deliverable bundle.');

  const files: OpenedFile[] = [];
  for (const entry of raw.files as unknown[]) {
    if (!isObject(entry) || typeof entry.data !== 'string') throw new Error('The bundle contains a malformed file.');
    const name = safeFileName(text(entry.name, 'File name', 120, true));
    const bytes = fromBase64(entry.data);
    const sha256 = await sha256Hex(bytes);
    const promised = preview.files.find((file) => file.name === name);
    const opened: OpenedFile = {
      name,
      type: typeof entry.type === 'string' && entry.type ? entry.type : 'application/octet-stream',
      size: bytes.length,
      sha256,
      bytes,
      matchesPreview: Boolean(promised && promised.sha256 === sha256 && promised.size === bytes.length),
    };
    if (textLike(opened)) opened.text = new TextDecoder().decode(bytes.subarray(0, 4000));
    files.push(opened);
  }

  const missing = preview.files.filter((file) => !files.some((opened) => opened.name === file.name)).map((file) => file.name);
  const allMatch = missing.length === 0
    && files.length === preview.files.length
    && files.every((file) => file.matchesPreview);
  return { note: typeof raw.note === 'string' ? raw.note : '', files, missing, allMatch };
}
