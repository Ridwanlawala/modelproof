import { exportPublicKey, generateSigningKey } from './lib/manifest';
import { arweaveAddress, generateArweaveJwk } from './lib/arweave';

// Keys live only in this browser's IndexedDB. Nothing is ever sent to a server.
const DB = 'modelproof', STORE = 'keys';

function db(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function get<T>(k: string): Promise<T | undefined> {
  const d = await db();
  return new Promise((res, rej) => { const r = d.transaction(STORE).objectStore(STORE).get(k); r.onsuccess = () => res(r.result as T); r.onerror = () => rej(r.error); });
}
async function put(k: string, v: unknown): Promise<void> {
  const d = await db();
  return new Promise((res, rej) => { const t = d.transaction(STORE, 'readwrite'); t.objectStore(STORE).put(v, k); t.oncomplete = () => res(); t.onerror = () => rej(t.error); });
}

export async function getSigningKey(): Promise<{ pair: CryptoKeyPair; publicKey: string }> {
  let pair = await get<CryptoKeyPair>('ed25519');
  if (!pair) { pair = await generateSigningKey(true); await put('ed25519', pair); }
  return { pair, publicKey: await exportPublicKey(pair.publicKey) };
}

export async function importSigningKey(privateJwk: JsonWebKey): Promise<void> {
  const privateKey = await crypto.subtle.importKey('jwk', privateJwk, { name: 'Ed25519' }, true, ['sign']);
  const publicKey = await crypto.subtle.importKey('jwk', { kty: privateJwk.kty, crv: privateJwk.crv, x: privateJwk.x }, { name: 'Ed25519' }, true, ['verify']);
  await put('ed25519', { privateKey, publicKey });
}

export async function exportSigningKey(): Promise<JsonWebKey> {
  return crypto.subtle.exportKey('jwk', (await getSigningKey()).pair.privateKey);
}

export async function getArweaveWallet(create = false): Promise<{ jwk: JsonWebKey; address: string } | undefined> {
  let jwk = await get<JsonWebKey>('arweave');
  if (!jwk && create) { jwk = await generateArweaveJwk(); await put('arweave', jwk); }
  return jwk ? { jwk, address: await arweaveAddress(jwk) } : undefined;
}

export async function importArweaveWallet(jwk: JsonWebKey): Promise<void> {
  if (jwk.kty !== 'RSA' || !jwk.n || !jwk.d) throw new Error('Not an Arweave JWK wallet');
  await put('arweave', jwk);
}
