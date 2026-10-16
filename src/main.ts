import './style.css';
import type { FileDigest } from './lib/hash';
import { buildManifest, fileEntry, serialize, signManifest, verifySignature, type FileEntry, type SignedManifest } from './lib/manifest';
import { compareFile, chunkRanges } from './lib/verify';
import { FREE_LIMIT, createDataItem, fetchFromArweave, manifestTags, uploadToTurbo } from './lib/arweave';
import { exportSigningKey, getArweaveWallet, getSigningKey, importArweaveWallet, importSigningKey } from './keys';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const fmt = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KiB` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MiB` : `${(n / 1073741824).toFixed(2)} GiB`);
const short = (h: string) => `${h.slice(0, 10)}…${h.slice(-6)}`;

// ---------- tabs ----------
document.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab!)));
function showTab(t: string) {
  document.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === t)));
  document.querySelectorAll<HTMLElement>('.panel').forEach((p) => (p.hidden = p.id !== t));
  if (t === 'keys') renderKeys();
}

// ---------- worker hashing ----------
const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
let seq = 0;
function hashInWorker(file: Blob, chunkSize: number, onProgress: (d: number, t: number) => void): Promise<FileDigest> {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const h = (e: MessageEvent) => {
      if (e.data.id !== id) return;
      if (e.data.type === 'progress') onProgress(e.data.done, e.data.total);
      else { worker.removeEventListener('message', h); e.data.type === 'done' ? resolve(e.data.digest) : reject(new Error(e.data.message)); }
    };
    worker.addEventListener('message', h);
    worker.postMessage({ id, file, chunkSize });
  });
}
function progress(scope: HTMLElement) {
  const box = scope.querySelector<HTMLElement>('.progress')!, bar = box.querySelector<HTMLElement>('i')!, txt = box.querySelector<HTMLElement>('.ptext')!;
  const t0 = performance.now();
  return {
    show: (label: string) => { box.hidden = false; bar.style.width = '0%'; txt.textContent = label; },
    set: (label: string, d: number, t: number) => {
      const pct = t ? (100 * d) / t : 100, secs = (performance.now() - t0) / 1000;
      bar.style.width = `${pct.toFixed(1)}%`;
      txt.textContent = `${label}: ${fmt(d)} / ${fmt(t)} (${pct.toFixed(0)}%) · ${secs > 0.5 ? fmt(d / secs) + '/s' : ''}`;
    },
    done: (label: string) => { bar.style.width = '100%'; txt.textContent = label; },
  };
}

// ---------- file pickers ----------
const picked: { model?: File; data: File[]; config: File[]; vModel?: File; manifest?: File } = { data: [], config: [] };
function bindDrop(inputId: string, onFiles: (f: File[]) => void) {
  const input = $<HTMLInputElement>(inputId), zone = input.closest('label')!;
  input.addEventListener('change', () => input.files && onFiles([...input.files]));
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', (e) => { e.preventDefault(); zone.classList.remove('over'); if (e.dataTransfer?.files.length) onFiles([...e.dataTransfer.files]); });
}
const names = (fs: File[]) => fs.map((f) => `${f.name} (${fmt(f.size)})`).join(', ');
bindDrop('modelFile', ([f]) => { picked.model = f; $('modelName').textContent = names([f]); if (!$<HTMLInputElement>('mName').value) $<HTMLInputElement>('mName').value = f.name.replace(/\.(gguf|onnx|safetensors|bin|pt)$/i, ''); });
bindDrop('dataFiles', (fs) => { picked.data = fs; $('dataNames').textContent = names(fs); });
bindDrop('configFiles', (fs) => { picked.config = fs; $('configNames').textContent = names(fs); });
bindDrop('vModelFile', ([f]) => { picked.vModel = f; $('vModelName').textContent = names([f]); });
bindDrop('manifestFile', ([f]) => { picked.manifest = f; $('manifestName').textContent = names([f]); $<HTMLInputElement>('txId').value = ''; });

async function sampleFile(path: string, name: string) {
  const r = await fetch(`./sample/${path}`);
  if (!r.ok) throw new Error(`could not load sample ${path}`);
  return new File([await r.blob()], name);
}

// ---------- publish ----------
let current: { signed: SignedManifest; text: string } | undefined;

$('demoPublish').addEventListener('click', async () => {
  picked.model = await sampleFile('tiny-mlp.safetensors', 'tiny-mlp.safetensors');
  picked.config = [await sampleFile('config.json', 'config.json')];
  picked.data = [];
  $('modelName').textContent = names([picked.model]); $('configNames').textContent = names(picked.config); $('dataNames').textContent = '';
  $<HTMLInputElement>('mName').value = 'tiny-mlp (my demo)'; $<HTMLInputElement>('mLicense').value = 'MIT';
  $<HTMLInputElement>('mBase').value = 'none (random init, seed 42)';
  $<HTMLSelectElement>('chunkSize').value = '16384';
});

$('hashBtn').addEventListener('click', async () => {
  const btn = $<HTMLButtonElement>('hashBtn');
  if (!picked.model) return alert('Choose a model file first.');
  const name = $<HTMLInputElement>('mName').value.trim();
  if (!name) return alert('Give the model a name.');
  const chunkSize = Number($<HTMLSelectElement>('chunkSize').value);
  const p = progress($('publish'));
  btn.disabled = true;
  try {
    const jobs: [FileEntry['role'], File][] = [['model', picked.model], ...picked.data.map((f) => ['dataset', f] as [FileEntry['role'], File]), ...picked.config.map((f) => ['config', f] as [FileEntry['role'], File])];
    const entries: FileEntry[] = [];
    for (const [role, f] of jobs) {
      p.show(`Hashing ${f.name}`);
      entries.push(fileEntry(role, f.name, await hashInWorker(f, chunkSize, (d, t) => p.set(`Hashing ${f.name}`, d, t))));
    }
    p.done('Signing…');
    const { pair, publicKey } = await getSigningKey();
    const manifest = buildManifest({
      model: { name, version: $<HTMLInputElement>('mVersion').value || '1.0.0', license: $<HTMLInputElement>('mLicense').value || 'unspecified', baseModel: $<HTMLInputElement>('mBase').value, sourceUrl: $<HTMLInputElement>('mUrl').value },
      files: entries, publicKey,
    });
    const signed = await signManifest(manifest, pair.privateKey);
    current = { signed, text: serialize(signed) };
    p.done(`Done: ${entries.length} file(s) hashed and signed.`);
    renderManifest();
  } catch (e) {
    p.done(`Error: ${(e as Error).message}`);
  } finally { btn.disabled = false; }
});

function renderManifest() {
  if (!current) return;
  const { manifest } = current.signed, model = manifest.files[0], bytes = new TextEncoder().encode(current.text).length;
  $('manifestCard').hidden = false;
  $('manifestFacts').innerHTML = [
    ['Model', `${esc(manifest.model.name)} v${esc(manifest.model.version)} · ${esc(manifest.model.license)}`],
    ['Model file', `${esc(model.name)} · ${fmt(model.size)} · ${model.chunkCount} chunks of ${fmt(model.chunkSize)}`],
    ['Merkle root', `<code>${manifest.merkleRoot}</code>`],
    ['SHA-256', `<code>${model.sha256}</code>`],
    ['Other files', String(manifest.files.length - 1)],
    ['Signer (Ed25519)', `<code>${manifest.signer.publicKey}</code>`],
  ].map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
  $('manifestJson').textContent = JSON.stringify(current.signed, null, 2);
  const fits = bytes + 2200 <= FREE_LIMIT; // ~2.1 KiB of ANS-104 headers (signature, owner, tags)
  $<HTMLButtonElement>('publishBtn').disabled = !fits;
  $('sizeHint').textContent = fits
    ? `Manifest is ${fmt(bytes)}, within ArDrive Turbo's free 100 KiB tier. No tokens needed.`
    : `Manifest is ${fmt(bytes)}, over the free 100 KiB tier. Use a larger chunk size, or download it and upload with a funded wallet.`;
  $('publishResult').innerHTML = '';
}

$('downloadBtn').addEventListener('click', () => {
  if (!current) return;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(current.signed, null, 2)], { type: 'application/json' }));
  a.download = `${current.signed.manifest.model.name.replace(/[^\w.-]+/g, '_')}.modelproof.json`;
  a.click();
});

$('publishBtn').addEventListener('click', async () => {
  if (!current) return;
  const btn = $<HTMLButtonElement>('publishBtn'), out = $('publishResult');
  btn.disabled = true;
  out.innerHTML = '<p class="hint">Preparing your Arweave wallet (first time: generating an RSA-4096 key, a few seconds)…</p>';
  try {
    const w = (await getArweaveWallet(true))!;
    const item = await createDataItem(new TextEncoder().encode(current.text), manifestTags(current.signed.manifest.merkleRoot, current.signed.manifest.model.name), w.jwk);
    out.innerHTML = '<p class="hint">Uploading signed data item to ArDrive Turbo…</p>';
    const res = await uploadToTurbo(item.raw);
    out.innerHTML = `<div class="ok"><strong>Stored permanently on Arweave.</strong>
      <dl class="facts"><dt>Transaction id</dt><dd><code>${esc(res.id)}</code> <button class="ghost tiny" data-copy="${esc(res.id)}">Copy</button></dd>
      <dt>Permanent link</dt><dd><a href="https://arweave.net/${esc(res.id)}" target="_blank" rel="noopener">arweave.net/${esc(res.id)}</a></dd>
      <dt>Instant mirror</dt><dd><a href="https://turbo-gateway.com/${esc(res.id)}" target="_blank" rel="noopener">turbo-gateway.com/${esc(res.id)}</a></dd>
      <dt>Uploader wallet</dt><dd><code>${esc(w.address)}</code></dd></dl>
      <p class="hint">arweave.net can take a few minutes to index a new item; the Turbo gateway serves it immediately.</p></div>`;
    out.querySelector<HTMLButtonElement>('[data-copy]')?.addEventListener('click', (e) => navigator.clipboard.writeText((e.target as HTMLElement).dataset.copy!));
    $<HTMLInputElement>('txId').value = res.id;
  } catch (e) {
    out.innerHTML = `<div class="bad"><strong>Upload failed:</strong> ${esc((e as Error).message)}<br/>Your manifest is still valid: download it and keep it, or try again later.</div>`;
  } finally { btn.disabled = false; }
});

// ---------- verify ----------
async function loadManifest(): Promise<{ signed: SignedManifest; source: string }> {
  const tx = $<HTMLInputElement>('txId').value.trim();
  if (tx) {
    const { text, gateway } = await fetchFromArweave(tx);
    return { signed: JSON.parse(text), source: `${gateway}/${tx}` };
  }
  if (picked.manifest) return { signed: JSON.parse(await picked.manifest.text()), source: picked.manifest.name };
  throw new Error('Enter an Arweave tx id or choose a manifest file.');
}

async function runVerify() {
  const btn = $<HTMLButtonElement>('verifyBtn'), out = $('verifyOut'), p = progress($('verify'));
  btn.disabled = true; $('verifyCard').hidden = true;
  try {
    if (!picked.vModel) throw new Error('Choose the model file to verify.');
    p.show('Fetching manifest…');
    const { signed, source } = await loadManifest();
    const sigOk = await verifySignature(signed);
    const entry = signed.manifest?.files?.find((f) => f.role === 'model');
    if (!entry) throw new Error('This is not a ModelProof manifest.');
    const f = picked.vModel;
    const digest = await hashInWorker(f, entry.chunkSize, (d, t) => p.set(`Re-hashing ${f.name}`, d, t));
    const r = compareFile(entry, digest);
    const rootTagOk = signed.manifest.merkleRoot === entry.merkleRoot;
    const all = sigOk && r.ok && rootTagOk;
    p.done(all ? 'Verified.' : 'Verification failed.');
    const mark = (ok: boolean) => (ok ? '<span class="yes">✔</span>' : '<span class="no">✘</span>');
    const cells = entry.chunks
      ? `<div class="chunks" aria-label="chunk map">${Array.from({ length: Math.max(entry.chunkCount, digest.chunks.length) }, (_, i) => `<i class="${r.differingChunks.includes(i) ? 'diff' : ''}" title="chunk ${i}"></i>`).join('')}</div>`
      : '';
    out.innerHTML = `
      <h2 class="${all ? 'yes' : 'no'}">${all ? '✔ Authentic: this file matches the signed manifest' : '✘ Does not match the signed manifest'}</h2>
      <ul class="checks">
        <li>${mark(sigOk)} Ed25519 signature over the canonical manifest</li>
        <li>${mark(r.merkleMatch)} Merkle root <code>${short(digest.merkleRoot)}</code> vs signed <code>${short(entry.merkleRoot)}</code></li>
        <li>${mark(r.sha256Match)} Whole-file SHA-256</li>
        <li>${mark(r.sizeMatch)} Size ${fmt(digest.size)} vs ${fmt(entry.size)}</li>
        <li>${mark(r.differingChunks.length === 0)} ${entry.chunks ? `${(entry.chunkCount - r.differingChunks.filter((i) => i < entry.chunkCount).length)}/${entry.chunkCount} chunks match` : 'chunk list not in manifest'}</li>
      </ul>
      ${cells}
      ${r.differingChunks.length ? `<p class="bad">Tampered or corrupted chunk(s): ${chunkRanges(r.differingChunks.slice(0, 50), entry.chunkSize, Math.max(digest.size, entry.size)).join(', ')}${r.differingChunks.length > 50 ? ` … and ${r.differingChunks.length - 50} more` : ''}</p>` : ''}
      <dl class="facts"><dt>Model</dt><dd>${esc(signed.manifest.model.name)} v${esc(signed.manifest.model.version)} · ${esc(signed.manifest.model.license)}</dd>
      ${signed.manifest.model.baseModel ? `<dt>Base model</dt><dd>${esc(signed.manifest.model.baseModel)}</dd>` : ''}
      ${signed.manifest.model.sourceUrl ? `<dt>Source</dt><dd><a href="${esc(signed.manifest.model.sourceUrl)}" target="_blank" rel="noopener">${esc(signed.manifest.model.sourceUrl)}</a></dd>` : ''}
      <dt>Signed by</dt><dd><code>${esc(signed.manifest.signer.publicKey)}</code></dd>
      <dt>Created</dt><dd>${esc(signed.manifest.createdAt)}</dd>
      <dt>Manifest from</dt><dd>${esc(source)}</dd></dl>`;
    $('verifyCard').hidden = false;
  } catch (e) {
    p.done(`Error: ${(e as Error).message}`);
  } finally { btn.disabled = false; }
}
$('verifyBtn').addEventListener('click', runVerify);

async function demo(tampered: boolean) {
  const info = await (await fetch('./sample/tiny-mlp.arweave.json')).json();
  $<HTMLInputElement>('txId').value = info.txId; picked.manifest = undefined; $('manifestName').textContent = '';
  const file = tampered ? 'tiny-mlp.tampered.safetensors' : 'tiny-mlp.safetensors';
  picked.vModel = await sampleFile(file, file);
  $('vModelName').textContent = names([picked.vModel]);
  runVerify();
}
$('demoGood').addEventListener('click', () => demo(false));
$('demoBad').addEventListener('click', () => demo(true));

// ---------- keys ----------
async function renderKeys() {
  const { publicKey } = await getSigningKey();
  const w = await getArweaveWallet(false);
  $('keyFacts').innerHTML = `<dt>Ed25519 public key</dt><dd><code>${publicKey}</code></dd><dt>Arweave wallet</dt><dd>${w ? `<code>${w.address}</code>` : 'not created yet (made on first publish)'}</dd>`;
}
const download = (obj: unknown, name: string) => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(obj)], { type: 'application/json' })); a.download = name; a.click(); };
$('exportEd').addEventListener('click', async () => download(await exportSigningKey(), 'modelproof-ed25519-private.jwk.json'));
$('exportAr').addEventListener('click', async () => { const w = await getArweaveWallet(true); download(w!.jwk, `arweave-wallet-${w!.address}.json`); renderKeys(); });
$<HTMLInputElement>('importEd').addEventListener('change', async (e) => { const f = (e.target as HTMLInputElement).files?.[0]; if (f) { await importSigningKey(JSON.parse(await f.text())); renderKeys(); } });
$<HTMLInputElement>('importAr').addEventListener('change', async (e) => { const f = (e.target as HTMLInputElement).files?.[0]; if (f) { await importArweaveWallet(JSON.parse(await f.text())); renderKeys(); } });

if (!('subtle' in crypto)) alert('This browser lacks WebCrypto; ModelProof needs a modern browser over HTTPS.');
