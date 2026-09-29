# ZoKo marketplace export

ZoKo version 1.3.0. You may download, install, and execute unmodified official plugin releases for your authorized work under plugins/zoko/LICENSE.txt, without requesting individual permission. Modification, redistribution, sublicensing, and sale rights remain reserved. Marketplace charges and service terms apply separately. Generating this directory does not publish it or establish global directory approval.

Use Node.js 24. Check that your Codex CLI exposes the documented commands with `codex plugin --help` and `codex plugin marketplace add --help`. Older CLI builds may not support plugin add/list or --json.

Install from this directory:

```sh
codex plugin marketplace add . --json
codex plugin add zoko@zoko --json
codex plugin list --available --json
```

The chosen official Git distribution ref is `codex/zoko-marketplace`. After that ref is published with this complete directory at its root, verify provenance and register it with `codex plugin marketplace add QuantumStonks/ZoKo --ref codex/zoko-marketplace --json` before adding zoko@zoko. Retain hidden directories when publishing. The development branch's raw plugins/zoko directory does not contain the bundled runtime.

Inspect provenance.json for archive SHA-256, source commit, source cleanliness and every exported file hash. The plugin still requires a user-selected ZoKo marketplace and account. Installation does not provide a marketplace, funds or sellers.
