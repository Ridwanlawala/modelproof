import { b64url, buf, fromB64url, utf8 } from './bytes';
import type { FileDigest } from './hash';

export const SCHEMA = 'modelproof/manifest@1';

export type Role = 'model' | 'dataset' | 'config';

export interface FileEntry {
  role: Role;
  name: string;
  size: number;
  sha256: string;
  chunkSize: number;
  chunkCount: number;
  merkleRoot: string;
  /** Per-chunk SHA-256. Kept for the model file (tamper localisation); omitted for datasets/configs to stay small. */
  chunks?: string[];
}

export interface Manifest {
  schema: typeof SCHEMA;
  model: { name: string; version: string; license: string; baseModel?: string; sourceUrl?: string };
  files: FileEntry[];
  /** Merkle root of the primary model file: the value tagged on Arweave. */
  merkleRoot: string;
  createdAt: string;
  signer: { alg: 'Ed25519'; publicKey: string };
}

export interface SignedManifest { manifest: Manifest; signature: string }

/**
 * Deterministic JSON: object keys sorted by code point, no whitespace,
 * undefined members dropped. Equivalent to RFC 8785 (JCS) for the value types
 * a manifest uses (strings, safe integers, arrays, objects).
 */
export function canonicalize(v: unknown): string {
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error('non-finite number in manifest');
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) return `[${v.map((x) => canonicalize(x === undefined ? null : x)).join(',')}]`;
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(o[k])}`).join(',')}}`;
  }
  throw new Error(`unsupported value in manifest: ${typeof v}`);
}

export function fileEntry(role: Role, name: string, d: FileDigest, keepChunks = role === 'model'): FileEntry {
  return {
    role, name, size: d.size, sha256: d.sha256, chunkSize: d.chunkSize,
    chunkCount: d.chunks.length, merkleRoot: d.merkleRoot, ...(keepChunks ? { chunks: d.chunks } : {}),
  };
}

/** RFC 3339 UTC timestamp computed from epoch ms (independent of Date string formatting). */
export function isoUtc(ms: number): string {
  const days = Math.floor(ms / 86_400_000), rem = ms - days * 86_400_000;
  // Howard Hinnant's civil_from_days
  const z = days + 719_468, era = Math.floor(z / 146_097), doe = z - era * 146_097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36_524) - Math.floor(doe / 146_096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153), d = doy - Math.floor((153 * mp + 2) / 5) + 1, m = mp < 10 ? mp + 3 : mp - 9;
  const y = yoe + era * 400 + (m <= 2 ? 1 : 0);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  const hh = Math.floor(rem / 3_600_000), mm = Math.floor((rem % 3_600_000) / 60_000), ss = Math.floor((rem % 60_000) / 1000);
  return `${p(y, 4)}-${p(m)}-${p(d)}T${p(hh)}:${p(mm)}:${p(ss)}.${p(rem % 1000, 3)}Z`;
}

export function buildManifest(opts: {
  model: Manifest['model'];
  files: FileEntry[];
  publicKey: string;
  createdAt?: string;
}): Manifest {
  const primary = opts.files.find((f) => f.role === 'model');
  if (!primary) throw new Error('a manifest needs one model file');
  const clean = (s?: string) => (s && s.trim() ? s.trim() : undefined);
  return {
    schema: SCHEMA,
    model: {
      name: opts.model.name.trim(), version: opts.model.version.trim(), license: opts.model.license.trim(),
      baseModel: clean(opts.model.baseModel), sourceUrl: clean(opts.model.sourceUrl),
    },
    files: opts.files,
    merkleRoot: primary.merkleRoot,
    createdAt: opts.createdAt ?? isoUtc(Date.now()),
    signer: { alg: 'Ed25519', publicKey: opts.publicKey },
  };
}

export async function generateSigningKey(extractable = true): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey({ name: 'Ed25519' }, extractable, ['sign', 'verify'])) as CryptoKeyPair;
}

export async function exportPublicKey(k: CryptoKey): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.exportKey('raw', k)));
}

export async function signManifest(m: Manifest, privateKey: CryptoKey): Promise<SignedManifest> {
  const sig = await crypto.subtle.sign({ name: 'Ed25519' }, privateKey, buf(utf8(canonicalize(m))));
  return { manifest: m, signature: b64url(new Uint8Array(sig)) };
}

/** Checks the Ed25519 signature against the public key embedded in the manifest. */
export async function verifySignature(s: SignedManifest): Promise<boolean> {
  try {
    if (s.manifest?.schema !== SCHEMA || s.manifest.signer?.alg !== 'Ed25519') return false;
    const pub = await crypto.subtle.importKey('raw', buf(fromB64url(s.manifest.signer.publicKey)), { name: 'Ed25519' }, false, ['verify']);
    return await crypto.subtle.verify({ name: 'Ed25519' }, pub, buf(fromB64url(s.signature)), buf(utf8(canonicalize(s.manifest))));
  } catch {
    return false;
  }
}

export function serialize(s: SignedManifest): string {
  return canonicalize(s);
}
