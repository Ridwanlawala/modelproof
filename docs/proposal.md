# ModelProof: Proposal Summary (HackerNoon Decentralize AI Hackathon, Round 1)

**Builder:** Lawal Ridwan, frontend/web3 developer, Nigeria
**Repo:** https://github.com/Ridwanlawala/modelproof · **Live:** https://ridwanlawala.github.io/modelproof/
**Arweave proof:** tx `8Fw3X6381ocPzuyaGtPsOhcSrGbHWudVLo5TfD82orc` (https://arweave.net/8Fw3X6381ocPzuyaGtPsOhcSrGbHWudVLo5TfD82orc)

AI weights move through mirrors, chat groups and re-uploads, and their provenance usually lives on a hosted page that can be edited or deleted. ModelProof is an open-source, browser-only PWA that gives models verifiable, permanent provenance. It streams a model file of any size through a Web Worker, computes a SHA-256 per 4 MiB chunk plus a domain-separated Merkle root, and builds a manifest covering metadata, licence, base model, Hugging Face source and dataset/config hashes. It signs that manifest with an in-browser Ed25519 key. The manifest is published to Arweave free of charge through ArDrive Turbo, using a hand-written ANS-104 encoder on WebCrypto with no SDK and no backend, and is tagged by `App-Name` and `Merkle-Root`. Anyone can then verify a copy of the weights from a tx id: the app checks the signature and root and pinpoints the exact chunks that were altered.

The project fits the hackathon's goals of permanent storage, verifiable AI and data sovereignty: keys and files never leave the user's device. It ships with 18 passing Vitest tests, CI, an MIT licence and a real on-chain demo that includes tamper detection. Next steps: Nosana inference attestations linking weights to outputs, Hugging Face hash cross-checks, and a release GitHub Action.
