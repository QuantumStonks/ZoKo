# Independent Codex marketplace distribution

The marketplace exporter prepares a complete Git marketplace checkout for review. It neither publishes a branch nor registers or installs anything in a user's Codex account. A custom Git marketplace and OpenAI's global plugin directory are separate distribution mechanisms. This export does not establish public directory approval or eligibility.

The owner authorized public distribution under XECKZ Inc. while retaining proprietary rights. The package's `LICENSE.txt` permits downloading, installing, and executing unmodified official plugin releases for authorized work, including the copies required for installation, host-managed caching, execution, and backup. No additional individual permission is required for that use. Modification, redistribution, sublicensing, and sale rights remain reserved; contribution ownership is unchanged. Preserve the license and third-party notices in the export.

## Prepare and inspect

Use Node.js 24, installed repository dependencies, and an already validated release. When a fresh release is needed, build it first; the marketplace command deliberately consumes the existing build without recompiling it.

```sh
npm run build:plugin
npm run build:plugin-marketplace
```

The second command creates the ignored `dist/plugin-marketplace` directory:

```text
.agents/plugins/marketplace.json
plugins/zoko/.codex-plugin/plugin.json
plugins/zoko/plugin.json
plugins/zoko/runtime/{cli,client,protocol}.mjs
plugins/zoko/skills/...
plugins/zoko/assets/...
plugins/zoko/README.md
plugins/zoko/LICENSE.txt
plugins/zoko/THIRD_PARTY_NOTICES.txt
plugins/zoko/integrity.json
README.md
provenance.json
```

The [catalog](https://developers.openai.com/plugins/build/plugins#marketplace-metadata) is named `zoko`, points to the local source `./plugins/zoko`, and declares `AVAILABLE` installation with `ON_INSTALL` authentication. The staged plugin is the exact built package, including both manifests and the bundled runtime. **Do not register the development repository's raw `plugins/zoko` source as a distributable marketplace:** it lacks the runtime that the skills execute.

Before writing output, the exporter verifies every package file against `integrity.json`, the archive SHA-256 sidecar, ZIP local/central records and CRCs, and the archive's exact contents against the built directory. It rejects extra files, symlinks, unsafe paths, oversized inputs and overlapping output paths. Existing exports are replaced only when their complete provenance inventory still matches; local changes or extra files cause refusal instead of deletion.

`provenance.json` records the release archive name, byte count and SHA-256, checkout commit, whether package source paths are clean, and hashes of every exported file except the provenance file itself. Runtime input hashes and static package bytes must match the current checkout. `sourceCommit` identifies checkout HEAD at export time; when `packageSourcesClean` is false it does not claim the package was built exclusively from that commit. The command prints the provenance hash separately. Retain its JSON output with the review receipt.

## Authorized installation

The following command contract is documented by [OpenAI's Codex plugin CLI guide](https://learn.chatgpt.com/docs/developer-commands#codex-plugin). Check the installed CLI before using it:

```sh
codex plugin --help
codex plugin marketplace add --help
```

Older CLI builds may lack `plugin add`, `plugin list` or `--json`; the machine's original `0.130.0-alpha.5` CLI does. Documentation support does not prove support in that binary. Use a supported official Codex version and verify its help instead of silently changing global installation or authentication. An isolated CLI test must use separate configuration and leave the user's existing marketplaces and credentials untouched.

The earlier staged version 1.2.2 was tested with official `@openai/codex` 0.159.0 in an isolated configuration: local marketplace discovery, installation, installed/enabled readback, all 21 cached package files and CLI startup passed. App-server initialization and `skills/list` loaded all three namespaced skills from the installed cache, enabled and with no loader errors. The private receipts are `.local/plugin-evidence/isolated-codex-discovery-1.2.2.json` and `.local/plugin-evidence/isolated-codex-skills-1.2.2.json`. This establishes a local host test for that version, not public publication or validation of a later release. No model conversation or live marketplace workflow was exercised. Consult `ops/plugin-state.json` for the current release's evidence.

To install the staged export in the chosen Codex profile, run these commands from its root, or replace `.` with its absolute path:

```sh
codex plugin marketplace add . --json
codex plugin add zoko@zoko --json
codex plugin list --available --json
```

Inspect command results for the marketplace `zoko`, plugin `zoko`, and expected version. Keep registration, installation, enabled status, runtime startup, and a completed marketplace workflow as distinct evidence. Execution requires Node.js 24; marketplace workflows require a user-selected marketplace URL and, for authenticated operations, an account. Installation does not provide funds or seller availability.

## Published Git catalog

The [public catalog branch](https://github.com/QuantumStonks/ZoKo/tree/codex/zoko-marketplace) is published and its Git reference was read back on 2026-09-29. Version 1.3.0 is at catalog commit `63c121fadb8c9ea4a4dd2ac88aceebd42d6dbd13`, exported from source commit `5b6a40329be11374af064eeb758aba6d054dcdc1`, with archive SHA-256 `d8da60ee46ceac3edf804469b0982088ff13ee0b8954b6af66fd12a37c6de0ee`.

Official Codex 0.159.0 anonymously cloned the published catalog in an isolated configuration, verified the pinned checkout, provenance, and archive, installed all 22 package files, and loaded all three skills enabled with zero loader errors. The private receipt is `.local/plugin-evidence/remote-codex-marketplace-1.3.0.json`, SHA-256 `b00531e89dfe6d1678bed85f07337f8761e526b509b643911e2c5b14f2f9e01b`. This proves remote catalog installation and skill loading for that release and host; it does not establish a completed live purchase, universal-directory publication, or other users' installations. Version 1.3.0 supports seller job delivery from an active owner agent session; a connected marketplace and timely seller execution remain necessary.

Register the published branch with a supported Codex CLI:

```sh
codex plugin marketplace add QuantumStonks/ZoKo --ref codex/zoko-marketplace --json
codex plugin add zoko@zoko --json
codex plugin list --available --json
```

For subsequent releases, publish the **complete staged directory** at the catalog branch's root, including `.agents` and `.codex-plugin`; do not copy only visible files. Record the new immutable Git commit and archive hash. Prefer an immutable published commit for reproducible registration where the target CLI supports a commit as `--ref`. Test each Git release separately; successful local-root installation alone does not prove remote clone, update or end-user access. Consult `ops/plugin-state.json` for the remote test result.

The current paid AI-decision product also has an unresolved universal-directory commerce-policy conflict; see [the policy review](plugin-policy-review.md). Provider company verification and directory attestations belong to that submission process, not this independent catalog release. A hosted marketplace, eligible sellers, funded accounts, and bounded spending authorization are needed to prove real paid use; they are not prerequisites for publishing the installable plugin. Independent publication does not confer directory approval or imply an exemption from any applicable policy. The user declined the policy inquiry, which remains unsent.

## Current live release: 1.3.1

Published catalog commit `2b63b4f6da096954d4879810d3094b32806d1f2f` is exported from tested source `d5f4aaceed857bf1a656633c54a6bd4cf6c747dd`, with ZIP SHA-256 `f2bd767fe294c83c82a25f4b760eae5a4b1b532372e62971fd5ced8e4294d640`. Anonymous official Codex 0.159.0 installed all 22 files and loaded all three enabled skills with zero loader errors. Readback receipt: `.local/plugin-evidence/remote-codex-marketplace-1.3.1.json`, SHA-256 `7f4bfc5fece0cd1ff225e71ac847d59692651fabb68b8d0ecd895af47aa5f14b`. The public [release ZIP and checksum](https://github.com/QuantumStonks/ZoKo/releases/tag/zoko-v1.3.1) also passed anonymous exact-byte readback. The live [plugin website](https://zoko.46.225.106.23.sslip.io/plugin/) hosts installation, support, privacy and terms. This is verified independent distribution, distinct from universal-directory review/publication and customer adoption.
