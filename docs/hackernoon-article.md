# ModelProof: I Built a Browser-Only Way to Prove an AI Model Hasn't Been Tampered With, Stored Forever on Arweave

**TL;DR:** ModelProof hashes any AI model in your browser, signs a provenance manifest with Ed25519 and stores it permanently on Arweave for free, so anyone can later prove a copy of the weights is authentic, or see exactly which chunks were changed.

**Tags:** decentralize-ai-hackathon, arweave, ai, web3, open-source

---

I'm Lawal Ridwan, a frontend and web3 developer from Nigeria. Most of the models I run are ones I downloaded: a GGUF from a mirror, a fine-tune a friend shared on Telegram, an ONNX export someone uploaded "with fixes". Every time, I'm trusting a filename, and I don't like that.

So for the HackerNoon Decentralize AI Hackathon I built **ModelProof**, a small open-source PWA that gives AI weights the kind of provenance we already expect from software releases, with no server in the middle.

- Live app: https://ridwanlawala.github.io/modelproof/
- Code (MIT): https://github.com/Ridwanlawala/modelproof

## The problem: weights are just bytes, and bytes move

There are three ways things go wrong today.

1. **Swapped or tampered weights.** A model file can be re-quantised, backdoored or quietly "patched" and re-uploaded under the same name. Most people never check a hash, and when they do, there's often nothing trustworthy to compare it with.
2. **Provenance lives on platforms that can change it.** The model card, the licence and the "trained on X" claim sit on a hosted page. Repos get deleted, made private or rewritten, and the record goes with them.
3. **A single hash is a blunt tool.** If a 7 GB file's SHA-256 doesn't match, you learn *that* something changed but not *what*. Was it one corrupted block from a flaky download, or edited weights?

Decentralised AI needs a provenance layer that is permanent, publicly checkable and doesn't ask you to trust whoever hosts the file.

## What ModelProof does

1. **Fingerprint.** Drop a model (GGUF, ONNX, safetensors; multi-GB is fine) plus optional dataset and config files. A Web Worker streams the file in 4 MiB slices, hashes each chunk with SHA-256, keeps a running whole-file SHA-256 (the same value Hugging Face shows for LFS files) and builds a Merkle root. Only one chunk is in memory at a time.
2. **Sign.** The app builds a manifest (name, version, licence, base model, Hugging Face URL, file sizes, chunk hashes, Merkle root, dataset hashes, timestamp), canonicalises it and signs it with an Ed25519 key generated in your browser by WebCrypto. The key stays in IndexedDB and you can export it.
3. **Publish permanently.** The signed manifest is wrapped in an ANS-104 data item, signed with a locally generated Arweave wallet and posted to ArDrive Turbo. Turbo uploads under 100 KiB are free, so publishing costs nothing and needs no tokens. It is tagged `App-Name: ModelProof` and `Merkle-Root: <root>`, so it can be found later.
4. **Verify.** Paste an Arweave transaction id (or drop a manifest file), drop the model you want to check, and ModelProof re-hashes it, checks the signature, compares the Merkle root and shows a chunk map with the exact byte ranges that differ.

There is no backend. The whole app is about 19 KB of JavaScript (7 KB gzipped) and installs as an offline PWA.

## Architecture

```
model file ─► Web Worker ─► SHA-256 per 4 MiB chunk ─► Merkle root
                                                         │
metadata + dataset/config hashes ───────────────────────►│
                                                         ▼
               canonical JSON ─► Ed25519 signature (WebCrypto)
                                                         ▼
          ANS-104 data item (RSA-PSS, local Arweave JWK) ─► upload.ardrive.io (free < 100 KiB)
                                                         ▼
                              Arweave tx id ─► arweave.net/<id>
```

Two design choices are worth explaining.

**A domain-separated Merkle tree.** Leaves are `SHA-256(0x00 ‖ chunkHash)` and inner nodes are `SHA-256(0x01 ‖ left ‖ right)`. An odd node is promoted rather than duplicated, which avoids the classic ambiguity where `[a, b, c]` and `[a, b, c, c]` share a root. Storing every chunk hash in the manifest is what lets the verifier say "chunk #812 changed" instead of just "no".

**No Arweave SDK.** I wanted the app to stay tiny and free of Node polyfills, so I implemented the ANS-104 data-item format directly on WebCrypto: Avro-encoded tags, Arweave's SHA-384 "deep hash", RSA-PSS signing and the binary layout. It comes to about 120 lines. Here's the core:

```ts
export async function createDataItem(data: Uint8Array, tags: Tag[], jwk: JsonWebKey) {
  const owner = fromB64url(jwk.n!);                 // 512-byte RSA modulus
  const tagBytes = serializeTags(tags);             // Avro array of {name, value}
  const empty = new Uint8Array(0);
  const msg = await deepHash([utf8('dataitem'), utf8('1'), utf8('1'),
                              owner, empty, empty, tagBytes, data]);
  const key = await crypto.subtle.importKey('jwk', { ...jwk, alg: 'PS256' },
                { name: 'RSA-PSS', hash: 'SHA-256' }, false, ['sign']);
  const signature = new Uint8Array(
    await crypto.subtle.sign({ name: 'RSA-PSS', saltLength: 32 }, key, buf(msg)));
  const raw = concat(new Uint8Array([1, 0]), signature, owner,
                     new Uint8Array([0]), new Uint8Array([0]),
                     u64le(tags.length), u64le(tagBytes.length), tagBytes, data);
  return { id: b64url(await sha('SHA-256', signature)), raw };
}
```

Then it's one `fetch` to `https://upload.ardrive.io/v1/tx` with `Content-Type: application/octet-stream`. Turbo checks the signature itself, so an item that's even slightly malformed gets rejected. That made Turbo accepting it a good end-to-end test of my encoder.

## A real verification walkthrough

The repo ships a tiny demo model, `tiny-mlp.safetensors` (a 256→48→10 MLP, 51,720 bytes), and a copy where I changed **one float32 weight** at byte 25,860.

I hashed the original with 16 KiB chunks (4 chunks, so the demo is easy to see), signed the manifest and published it through Turbo. This is the real transaction:

- **Tx id:** `8Fw3X6381ocPzuyaGtPsOhcSrGbHWudVLo5TfD82orc`
- **Permanent link:** https://arweave.net/8Fw3X6381ocPzuyaGtPsOhcSrGbHWudVLo5TfD82orc
- **Merkle root tag:** `9942b76f19bce75a7553db5a2de88b10bbc619e289e24fb922a80516605957bf`
- **Cost:** `"winc": "0"`, free

Querying the gateway's GraphQL returns the tags exactly as signed: `Content-Type: application/json`, `App-Name: ModelProof`, `Merkle-Root: 9942b76f…57bf` and `Model-Name: tiny-mlp (ModelProof demo)`.

In the app's **Verify** tab:

- **Original file:** the manifest is fetched from Arweave, the Ed25519 signature checks out, the Merkle root matches, the whole-file SHA-256 matches and all 4/4 chunks are green. Result: *Authentic*.
- **Tampered file:** same size and same filename, but the Merkle root and SHA-256 fail and the chunk map shows **chunk #1 (bytes 16384–32767)** in red. That's precisely the chunk holding the weight I edited.

The same scenario runs in CI as a Vitest test, alongside tests for the Merkle tree, canonicalisation, Ed25519 signing (any edit to the manifest, including changing the licence, breaks the signature) and ANS-104 signing round-trips. There are 18 tests and all of them pass.

## Limitations

I'd rather be upfront about these:

- **A signature proves *who*, not *whether to trust them*.** ModelProof binds a manifest to a key. Publishers still have to announce their public key somewhere you already trust: a website, a model card or an ArNS/ENS name.
- **Free-tier ceiling.** Each chunk hash costs about 67 bytes, so at 4 MiB chunks one free manifest covers a model of about 6 GB. Bigger models need larger chunks (the app warns you) or a funded wallet.
- **Propagation.** Turbo's gateway serves a new item immediately, but arweave.net can take a few minutes to index it. The verifier tries both.
- **Keys in IndexedDB.** If you clear site data, your keys are gone, so back them up from the Keys tab.
- **Provenance, not safety.** A matching hash proves the bytes are what was signed. It doesn't prove the model behaves well or that the training claims are true.

## What's next: Nosana inference attestations

Provenance for weights is step one. Next I want to run a verified model on **Nosana**'s decentralised GPU network and have each job publish a signed attestation of `{merkleRoot, inputHash, outputHash}` to Arweave next to the manifest. That would link "these exact weights" to "this exact output", which is the missing piece for verifiable inference. After that: automatic cross-checks against Hugging Face's LFS hashes, discovery by `Merkle-Root` tag ("who else has signed this model?"), and a GitHub Action that publishes a manifest with every model release.

If you ship models, try it on your next release and pin the tx id in your model card. It's free, it's permanent and it takes about a minute.
