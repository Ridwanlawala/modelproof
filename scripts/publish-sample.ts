// Publishes a signed manifest for the bundled sample model to Arweave via ArDrive Turbo (free < 100 KiB).
// Usage: npx vite-node scripts/publish-sample.ts <secretsDir>
// Keys are written to <secretsDir> (keep it OUT of the repo); the signed manifest goes to public/sample/.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hashBlob } from '../src/lib/hash';
import { buildManifest, exportPublicKey, fileEntry, generateSigningKey, serialize, signManifest } from '../src/lib/manifest';
import { arweaveAddress, createDataItem, generateArweaveJwk, manifestTags, uploadToTurbo } from '../src/lib/arweave';

const secrets = process.argv[2];
if (!secrets) throw new Error('pass a secrets dir outside the repo');
mkdirSync(secrets, { recursive: true });
const CHUNK = 16 * 1024;
const model = readFileSync('public/sample/tiny-mlp.safetensors');
const config = readFileSync('public/sample/config.json');
const kp = await generateSigningKey();
const m = buildManifest({
  model: { name: 'tiny-mlp (ModelProof demo)', version: '1.0.0', license: 'MIT', baseModel: 'none (random init, seed 42)', sourceUrl: 'https://github.com/Ridwanlawala/modelproof/tree/main/public/sample' },
  files: [
    fileEntry('model', 'tiny-mlp.safetensors', await hashBlob(new Blob([model]), CHUNK)),
    fileEntry('config', 'config.json', await hashBlob(new Blob([config]), CHUNK)),
  ],
  publicKey: await exportPublicKey(kp.publicKey),
});
const signed = await signManifest(m, kp.privateKey);
const body = new TextEncoder().encode(serialize(signed));
writeFileSync('public/sample/tiny-mlp.manifest.json', JSON.stringify(signed, null, 2));
const jwk = await generateArweaveJwk();
writeFileSync(`${secrets}/arweave-wallet.json`, JSON.stringify(jwk));
writeFileSync(`${secrets}/ed25519-private.jwk.json`, JSON.stringify(await crypto.subtle.exportKey('jwk', kp.privateKey)));
const item = await createDataItem(body, manifestTags(m.merkleRoot, m.model.name), jwk);
console.log('manifest bytes', body.length, 'data item bytes', item.raw.length, 'local id', item.id, 'owner', await arweaveAddress(jwk));
const res = await uploadToTurbo(item.raw);
console.log('TURBO', JSON.stringify(res));
writeFileSync('public/sample/tiny-mlp.arweave.json', JSON.stringify({ txId: res.id, url: `https://arweave.net/${res.id}`, merkleRoot: m.merkleRoot, owner: await arweaveAddress(jwk) }, null, 2));
