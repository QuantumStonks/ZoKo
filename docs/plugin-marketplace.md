# Staged Codex marketplace distribution

The marketplace exporter prepares a complete Git marketplace checkout for review. It neither publishes a branch nor registers or installs anything in a user's Codex account. A custom Git marketplace and OpenAI's global plugin directory are separate distribution mechanisms. This export does not establish public directory approval or eligibility.

ZoKo remains proprietary with all rights reserved. The owner authorized public distribution preparation, but public end-user license terms still require rights-holder review. The existing `LICENSE.txt` and third-party notices travel unchanged with the package. Do not present this export as a grant of public use or redistribution rights.

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

The staged version 1.2.2 was also tested with official `@openai/codex` 0.159.0 in an isolated configuration: local marketplace discovery, installation, installed/enabled readback, all 21 cached package files and CLI startup passed. App-server initialization and `skills/list` loaded all three namespaced skills from the installed cache, enabled and with no loader errors. The private receipts are `.local/plugin-evidence/isolated-codex-discovery-1.2.2.json` and `.local/plugin-evidence/isolated-codex-skills-1.2.2.json`. This establishes a local host test, not public publication or general account installation. No model conversation or live marketplace workflow was exercised.

After installation is authorized, run these commands from the staged export root, or replace `.` with its absolute path:

```sh
codex plugin marketplace add . --json
codex plugin add zoko@zoko --json
codex plugin list --available --json
```

Inspect command results for the marketplace `zoko`, plugin `zoko`, and expected version. Keep registration, installation, enabled status, runtime startup, and a completed marketplace workflow as distinct evidence. ZoKo requires Node.js 24, a user-selected marketplace URL and account; installation does not provide funds or seller availability.

## Future Git branch distribution

Publishing requires its own authorized action and resolved distribution terms. Place the **complete staged directory** at the root of the chosen distribution branch, including `.agents` and `.codex-plugin`. Do not copy only visible files. Record the resulting immutable Git commit and release archive hash in the distribution receipt.

After that branch actually exists, substitute its real name for the placeholder:

```sh
codex plugin marketplace add QuantumStonks/ZoKo --ref <published-marketplace-ref> --json
codex plugin add zoko@zoko --json
codex plugin list --available --json
```

The placeholder is not a published branch or an assertion of availability. Prefer an immutable published commit for reproducible registration where the target CLI supports a commit as `--ref`. Test the Git source separately after publication; successful local-root installation alone does not prove remote clone, update or end-user access.

The current paid AI-decision product also has an unresolved public directory commerce-policy conflict; see [the policy review](plugin-policy-review.md). Preparing a Git export does not resolve that policy or confer directory approval.
