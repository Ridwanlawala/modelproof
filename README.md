# ModelProof

**Verifiable AI model provenance, entirely in your browser, stored permanently on Arweave.**

[![CI](https://github.com/Ridwanlawala/modelproof/actions/workflows/ci.yml/badge.svg)](https://github.com/Ridwanlawala/modelproof/actions/workflows/ci.yml)
Live app: **https://ridwanlawala.github.io/modelproof/** · Licence: MIT

ModelProof fingerprints a model file (GGUF, ONNX, safetensors, any size), writes a signed provenance manifest and publishes it to Arweave, where nobody can quietly edit it or take it down. Anyone holding a copy of the weights can then check, offline and without trusting a server, that it is byte-for-byte the model the publisher signed, and if it is not, **which 4 MiB chunks were changed**.

There is no backend. Hashing, signing, wallet generation and verification all run client-side.

## Why

- Model weights get swapped, re-quantised, poisoned or silently "fixed" after release, and a filename tells you nothing.
- Hosting is centralised: a repo can be deleted, made private or rewritten, taking the provenance record with it.
- A plain SHA-256 says *that* a 7 GB file differs, not *where*. A Merkle tree over chunks pinpoints the change and lets the check stream with constant memory.

## Live proof

The bundled demo model's manifest is on Arweave:

| | |
|---|---|
| Transaction id | `8Fw3X6381ocPzuyaGtPsOhcSrGbHWudVLo5TfD82orc` |
| Permanent link | https://arweave.net/8Fw3X6381ocPzuyaGtPsOhcSrGbHWudVLo5TfD82orc |
| Instant mirror | https://turbo-gateway.com/8Fw3X6381ocPzuyaGtPsOhcSrGbHWudVLo5TfD82orc |
| Tags | `Content-Type: application/json`, `App-Name: ModelProof`, `Merkle-Root: 9942b76f…57bf`, `Model-Name` |
| Cost | 0 winc (ArDrive Turbo free tier) |

Open the app → **Verify** → *Demo: original sample* (✔ authentic) and *Demo: tampered sample* (✘, chunk #1 flagged: one float32 weight was changed).

## How it works

```
 model.gguf ──► Web Worker: stream 4 MiB slices ──► SHA-256 per chunk ─┐
                    └─► incremental whole-file SHA-256 (HF-compatible)  │
                                                                        ▼
                                          Merkle root (leaf = H(0x00‖chunk), node = H(0x01‖L‖R))
                                                                        │
 name, version, licence, base model, HF URL, dataset/config hashes ─────┤
                                                                        ▼
                       canonical JSON (sorted keys) ──► Ed25519 signature (WebCrypto, key in IndexedDB)
                                                                        │
                                      ANS-104 data item, RSA-PSS signed by a local Arweave JWK
                                                                        │
                       POST https://upload.ardrive.io/v1/tx  (free < 100 KiB) ──► Arweave tx id
```

| File | Role |
|---|---|
| `src/lib/hash.ts` | Streaming chunk hasher (one chunk in memory at a time) |
| `src/lib/merkle.ts` | Domain-separated Merkle tree, odd node promoted (no duplication ambiguity) |
| `src/lib/manifest.ts` | Manifest schema `modelproof/manifest@1`, canonicalisation, Ed25519 sign/verify |
| `src/lib/arweave.ts` | ~120-line ANS-104 builder: Avro tags, deep-hash (SHA-384), RSA-PSS signing, Turbo upload, gateway fetch |
| `src/lib/verify.ts` | Chunk-level comparison and tamper localisation |
| `src/worker.ts` | Hashing off the main thread with progress events |
| `src/keys.ts` | IndexedDB key storage, import/export |

No Arweave SDK is bundled: the data-item format is implemented directly on WebCrypto, so the whole app is ~19 KB of JS (7 KB gzipped) and installs as an offline PWA.

### Manifest (abridged)

```json
{
  "manifest": {
    "schema": "modelproof/manifest@1",
    "model": { "name": "…", "version": "1.0.0", "license": "MIT", "baseModel": "…", "sourceUrl": "https://huggingface.co/…" },
    "files": [
      { "role": "model", "name": "x.gguf", "size": 4368439584, "sha256": "…", "chunkSize": 4194304,
        "chunkCount": 1042, "merkleRoot": "…", "chunks": ["…", "…"] },
      { "role": "dataset", "name": "train.jsonl", "size": 1200000, "sha256": "…", "merkleRoot": "…", "chunkCount": 1, "chunkSize": 4194304 }
    ],
    "merkleRoot": "…",
    "createdAt": "2026-10-16T08:31:39.411Z",
    "signer": { "alg": "Ed25519", "publicKey": "<base64url raw key>" }
  },
  "signature": "<base64url Ed25519 signature over canonical(manifest)>"
}
```

## How to verify

**In the app:** Verify tab → paste a tx id (or drop a manifest file) → drop the model → *Verify*. You get the signature check, Merkle root, whole-file SHA-256, size, and a chunk map with the byte ranges of any altered chunks.

**By hand, without ModelProof:**

1. `curl -L https://arweave.net/<txid> > m.json`
2. Split the model into `chunkSize` pieces, SHA-256 each, and compare with `manifest.files[0].chunks` (e.g. `split -b 16384 tiny-mlp.safetensors c_ && sha256sum c_*`).
3. `sha256sum model` must equal `files[0].sha256`.
4. Verify the Ed25519 signature in `signature` over the canonical JSON of `manifest` (keys sorted, no whitespace) with `signer.publicKey`.

## Develop

```bash
npm ci
npm test        # Vitest: Merkle tree, canonicalisation + Ed25519, tamper detection, ANS-104 signing
npm run dev
npm run build   # static dist/ with relative base, deployable anywhere
npx vite-node scripts/publish-sample.ts ../secrets   # re-publish the sample manifest via Turbo (keys go outside the repo)
```

## Limitations (honest)

- **A signature proves who, not whether to trust them.** ModelProof binds a manifest to an Ed25519 key; it does not tell you that key belongs to Meta or Mistral. Publishers should announce their public key on a channel you already trust (website, HF model card, ENS/ArNS).
- **Free-tier size.** Turbo is free for data items up to 107,520 bytes. Each chunk hash costs ~67 bytes, so at 4 MiB chunks a single manifest covers a model of about **6 GB** for free. Larger models need a bigger chunk size (the app warns you) or a funded wallet. Dataset/config entries store only their root and SHA-256, not chunk lists.
- **Propagation.** A new upload is served at once by `turbo-gateway.com`; `arweave.net` can take minutes to index it. The verifier tries both. Turbo bundles items to Arweave L1 on its own schedule.
- **Browser support.** Needs WebCrypto Ed25519 (Chrome/Edge 137+, Firefox 129+, Safari 17+).
- **Keys live in IndexedDB.** Clearing site data deletes them; export a backup from the Keys tab. Keys are extractable by design, so treat the browser profile as sensitive.
- **Provenance, not behaviour.** A matching hash shows the bytes are what was signed, not that the model is safe or that training happened as claimed. Reproducible-training attestations are out of scope for this round.
- Whole-file hashing speed is bounded by the JS SHA-256 (roughly 150–400 MB/s on a laptop).

## Next steps

- **Nosana inference attestations:** run the verified model on Nosana's decentralised GPU network, have the job sign `{merkleRoot, inputHash, outputHash}` and publish it next to the manifest, linking "these weights" to "this output".
- Cross-check `sourceUrl` against Hugging Face's LFS SHA-256 automatically.
- Arweave GraphQL discovery by `App-Name`/`Merkle-Root` tag ("who else signed this model?").
- Publisher identity via ArNS / ENS names and key-rotation records.
- A CLI and a GitHub Action that publish a manifest on every model release.

## Licence

MIT © 2026 Lawal Ridwan
