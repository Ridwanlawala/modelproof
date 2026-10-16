import { b64url, buf, concat, fromB64url, sha, utf8 } from './bytes';

/**
 * Minimal ANS-104 data item builder/signer (Arweave signature type 1,
 * RSA-PSS SHA-256, 4096-bit) so the app can publish through ArDrive Turbo
 * without Node polyfills. Turbo uploads up to 100 KiB (107,520 bytes) are free.
 */
export const TURBO_UPLOAD = 'https://upload.ardrive.io/v1/tx';
export const FREE_LIMIT = 107_520;
export type Tag = { name: string; value: string };

export async function generateArweaveJwk(): Promise<JsonWebKey> {
  const kp = (await crypto.subtle.generateKey(
    { name: 'RSA-PSS', modulusLength: 4096, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true, ['sign', 'verify'],
  )) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
  return { kty: jwk.kty, n: jwk.n, e: jwk.e, d: jwk.d, p: jwk.p, q: jwk.q, dp: jwk.dp, dq: jwk.dq, qi: jwk.qi };
}

export async function arweaveAddress(jwk: JsonWebKey): Promise<string> {
  return b64url(await sha('SHA-256', fromB64url(jwk.n!)));
}

// Avro zig-zag varint (long)
function avroLong(n: number): Uint8Array {
  let z = n * 2; // n >= 0 here
  const out: number[] = [];
  while (z > 127) { out.push((z & 0x7f) | 0x80); z = Math.floor(z / 128); }
  out.push(z);
  return new Uint8Array(out);
}
const avroBytes = (b: Uint8Array) => concat(avroLong(b.length), b);

export function serializeTags(tags: Tag[]): Uint8Array {
  if (tags.length === 0) return new Uint8Array(0);
  return concat(avroLong(tags.length), ...tags.flatMap((t) => [avroBytes(utf8(t.name)), avroBytes(utf8(t.value))]), avroLong(0));
}

/** Arweave deep-hash (SHA-384) over nested byte arrays. */
export async function deepHash(d: Uint8Array | Uint8Array[]): Promise<Uint8Array> {
  if (d instanceof Uint8Array) {
    const tag = concat(utf8('blob'), utf8(String(d.length)));
    return sha('SHA-384', concat(await sha('SHA-384', tag), await sha('SHA-384', d)));
  }
  let acc = await sha('SHA-384', concat(utf8('list'), utf8(String(d.length))));
  for (const c of d) acc = await sha('SHA-384', concat(acc, await deepHash(c)));
  return acc;
}

const u64le = (n: number) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n), true); return b; };

export async function createDataItem(data: Uint8Array, tags: Tag[], jwk: JsonWebKey): Promise<{ id: string; raw: Uint8Array }> {
  const owner = fromB64url(jwk.n!);
  if (owner.length !== 512) throw new Error('Arweave key must be RSA-4096');
  const tagBytes = serializeTags(tags);
  const empty = new Uint8Array(0);
  const msg = await deepHash([utf8('dataitem'), utf8('1'), utf8('1'), owner, empty, empty, tagBytes, data]);
  const key = await crypto.subtle.importKey('jwk', { ...jwk, alg: 'PS256', ext: true }, { name: 'RSA-PSS', hash: 'SHA-256' }, false, ['sign']);
  const signature = new Uint8Array(await crypto.subtle.sign({ name: 'RSA-PSS', saltLength: 32 }, key, buf(msg)));
  const raw = concat(
    new Uint8Array([1, 0]), // signature type 1 (Arweave), u16 LE
    signature, owner,
    new Uint8Array([0]), // no target
    new Uint8Array([0]), // no anchor
    u64le(tags.length), u64le(tagBytes.length), tagBytes, data,
  );
  return { id: b64url(await sha('SHA-256', signature)), raw };
}

/** Re-verifies a data item's RSA-PSS signature locally (used in tests). */
export async function verifyDataItem(raw: Uint8Array): Promise<boolean> {
  const sig = raw.slice(2, 514), owner = raw.slice(514, 1026);
  let o = 1026;
  if (raw[o++] === 1) o += 32; // target
  if (raw[o++] === 1) o += 32; // anchor
  const dv = new DataView(raw.buffer, raw.byteOffset);
  o += 8; const tagLen = Number(dv.getBigUint64(o, true)); o += 8;
  const tagBytes = raw.slice(o, o + tagLen), data = raw.slice(o + tagLen);
  const e = new Uint8Array(0);
  const msg = await deepHash([utf8('dataitem'), utf8('1'), utf8('1'), owner, e, e, tagBytes, data]);
  const pub = await crypto.subtle.importKey('jwk', { kty: 'RSA', n: b64url(owner), e: 'AQAB' }, { name: 'RSA-PSS', hash: 'SHA-256' }, false, ['verify']);
  return crypto.subtle.verify({ name: 'RSA-PSS', saltLength: 32 }, pub, buf(sig), buf(msg));
}

export async function uploadToTurbo(raw: Uint8Array): Promise<{ id: string; owner?: string }> {
  if (raw.length > FREE_LIMIT) throw new Error(`Data item is ${raw.length} bytes; Turbo's free tier is ${FREE_LIMIT} bytes`);
  const r = await fetch(TURBO_UPLOAD, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: buf(raw) });
  const text = await r.text();
  if (!r.ok) throw new Error(`Turbo upload failed (${r.status}): ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

export const GATEWAYS = ['https://arweave.net', 'https://turbo-gateway.com'];

/** Fetches a manifest by tx id, trying arweave.net first then Turbo's gateway (new items can take a while to propagate). */
export async function fetchFromArweave(id: string): Promise<{ text: string; gateway: string }> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(id)) throw new Error('Not a valid Arweave transaction id (43 base64url chars)');
  let last = '';
  for (const g of GATEWAYS) {
    try {
      const r = await fetch(`${g}/${id}`);
      if (r.ok) return { text: await r.text(), gateway: g };
      last = `${g} → HTTP ${r.status}`;
    } catch (e) { last = `${g} → ${(e as Error).message}`; }
  }
  throw new Error(`Could not fetch ${id} (${last})`);
}

export function manifestTags(merkleRoot: string, modelName: string): Tag[] {
  return [
    { name: 'Content-Type', value: 'application/json' },
    { name: 'App-Name', value: 'ModelProof' },
    { name: 'App-Version', value: '0.1.0' },
    { name: 'Merkle-Root', value: merkleRoot },
    { name: 'Model-Name', value: modelName.slice(0, 120) },
  ];
}
