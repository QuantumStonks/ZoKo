# Use ZoKo in Codex

ZoKo gives Codex three discoverable workflows: connect to a marketplace, purchase typed decisions, and publish/manage seller offers. The package includes the actual CLI, client, and protocol schemas. It requires Node.js 24 on the execution host and an actual ZoKo marketplace URL. There is no default public market or model service.

## Install and verify

The owner authorized public distribution while retaining proprietary rights. Official plugin releases permit installation and use under the included license. An independent Codex catalog is separate from the universal plugin directory, where the paid offering's eligibility remains unresolved. See the [catalog distribution guide](plugin-marketplace.md) for its exact publication and verification state. You can also build the package from an authorized checkout:

```sh
npm ci --ignore-scripts
npm run build:plugin
```

The output is a versioned ZIP under `dist/plugins/`, its `.sha256` file, and the extracted `dist/plugins/zoko/` directory. The directory contains both the portable `plugin.json` and Codex compatibility manifest. Use Codex's plugin interface to install the package from your personal marketplace; a shared marketplace or public directory listing is a separate distribution step.

A maintainer can register the built directory with the bundled Plugin Creator's personal-marketplace scaffold, then replace the scaffold contents with the complete emitted directory, including hidden files. Do not install the source `plugins/zoko/` alone: its runtime is produced by the build. The default personal marketplace is `~/.agents/plugins/marketplace.json` and its local source is `~/plugins/zoko`. Use the app's View link to inspect and install it, then start a new chat so the host discovers the skills.

Check the extracted runtime from any working directory:

```sh
node /absolute/path/to/zoko/runtime/cli.mjs help
```

An installable package and successful local validation do not establish approved public directory publication. See [listing preparation](plugin-listing.md) and [tracked release state](../ops/plugin-state.json).

## Connect once

Supply `ZOKO_URL` and an ordinary `ZOKO_API_KEY` through the execution host's environment or secret manager. Use HTTPS except for loopback development. Never paste keys into a prompt or commit them. The plugin never needs a customer's wallet seed. Public `discover`, `catalog`, and `doctor` need no account key.

Ask Codex: “Connect to my ZoKo marketplace and show available sellers.” It will inspect the service and live catalog, then account limits when configured. An empty market requires seller onboarding; health alone does not establish a purchasable offer.

## Authorize the task, then let it proceed

A clear delegation specifies the task, permitted data, seller restrictions if any, per-purchase ceiling, cumulative budget, and applicable time window. Your agent carries those permissions forward. It should not ask again for each decision, seller update, or retry already covered by your instructions.

The agent tracks spent amounts and unresolved reservations against your task budget, including through interruptions. It may ask when required permission is missing, a limit would be exceeded, scope changes, or the execution host enforces an approval. An account's daily budget is another ceiling; it does not independently grant authority.

For instance, authorize a batch of classifications with a total budget and seller policy. The agent may quote and purchase each item within that delegation. Asking only for a quote does not authorize a purchase. Seller endpoint credentials, marketplace API credentials, and model-provider credentials have distinct purposes; see [seller integration](jev.md).

## Purchase and recover

The buyer skill validates the input and reviews an exact quote against the remaining authorization. A staged CLI purchase follows:

```sh
node /absolute/path/to/zoko/runtime/cli.mjs quote --input decision.json --max-price 0.25 --journal /private/path/purchase.json
node /absolute/path/to/zoko/runtime/cli.mjs execute --journal /private/path/purchase.json
```

These commands require your real input and account; the price is an illustrative ceiling, not permission to spend. Quotes do not run inference. A valid typed result is billable even below the requested confidence; inspect `accepted` separately from settlement status.

Before dispatch, the CLI persists the original payload, quote, key, account, and service URL. Retain the journal and its `.attempt.json` dispatch marker. After an interruption:

```sh
node /absolute/path/to/zoko/runtime/cli.mjs recover --journal /private/path/purchase.json
```

Recover with the same account and marketplace. Never create a replacement purchase merely because a response was lost. Ambiguity is an unresolved reservation until the actual ledger outcome is known. Legacy version-1 journals remain recoverable. Journals may contain sensitive task data and belong outside the installed plugin. POSIX mode restrictions do not substitute for appropriate Windows directory ACLs.

## Sell decisions

Ask Codex to publish your agent's real inference endpoint. The seller skill supplies the exact request/response contract, validates supported typed questions, registers an owned offer, and reads back its approval state. Registration requires an operator-admitted host and starts pending approval. The seller pays its upstream compute costs; ZoKo retains the operator-configured marketplace commission.

Seller updates support owned price, endpoint credential, and pause fields. The operator controls approval; endpoint/model identity changes require a new offer. Registration alone is not evidence of eligibility, customer demand, completed delivery, or earnings. Seller credits and on-chain withdrawal receipts are separate events.

## Operator deployment and support

Deployments need PostgreSQL, a dedicated service wallet, HTTPS, approved seller endpoints, secure secrets/backups, and an actual paid acceptance test. Follow [deployment](deployment.md) and [eCash operation](ecash.md). The plugin does not provide this infrastructure or transfer funds during setup.

Report plugin defects through GitHub with versions and redacted reproduction steps. Contact the chosen marketplace operator for its account, custody, settlement, and seller approval issues. Do not post secrets, full journals, or private inputs. [Maintenance](plugin-maintenance.md) defines how tests, measured activation, and truthful growth indicators drive future work.
