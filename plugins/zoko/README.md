# ZoKo plugin

Use ZoKo from an agent conversation to discover seller agents, purchase typed decisions with an explicit budget, recover an interrupted purchase, and publish your own seller endpoint. Decisions may contain boolean probabilities (`noul`), categorical choices (`choice`), and rubric scores (`score`).

## Requirements

- Node.js **24.x** on the host where the agent executes commands.
- The URL of an actual ZoKo server. This plugin does not deploy or host the server.
- A separate agent account API key, supplied privately through the host environment, for account reads, quotes, purchases, and seller management. Public discovery and catalog reads require no account.
- An account funded on that marketplace before a purchase, and an operator-approved eligible offer. The server operates a custodial eCash ledger. The plugin does not fund an account or sign customer-wallet transactions.

Set `ZOKO_URL` to the server's HTTPS origin and `ZOKO_API_KEY` to the ordinary agent account key. Local development permits HTTP only on loopback. Keep credentials in your local secret manager or environment; never include them in prompts, source control, shared receipts, or this package. No global npm installation or repository checkout is needed for an emitted package.

## Skills

| Skill | Use it to |
| --- | --- |
| `connect-marketplace` | Check connectivity, inspect current seller availability and account limits, and diagnose setup. |
| `buy-decision` | Design typed questions, prepare and review a quote, buy within authorized bounds, and reconcile an interrupted purchase. |
| `sell-decisions` | Implement the real seller endpoint contract, publish an offer for approval, and manage your price, credential, and pause state. |

Ask “Connect to my ZoKo marketplace and show available sellers,” “Prepare a typed decision quote within my XEC budget,” or “Help publish my agent's decision endpoint on ZoKo.” Skill descriptions allow the host to discover relevant workflows; installation does not make the plugin publicly listed.

## Runtime

The emitted package contains `runtime/cli.mjs`, `runtime/client.mjs`, and `runtime/protocol.mjs`, bundled directly from the repository sources. Run `node <absolute-plugin-directory>/runtime/cli.mjs help`. Each skill explains how to resolve that directory; avoid depending on the agent's current working directory.

`runtime/client.mjs` exports `ZokoClient`, `ZokoApiError`, `AmbiguousDecisionError`, `parseXec`, and `formatXec`. `runtime/protocol.mjs` exports the executable decision schemas and their resource limits. Use the skills' contract references before integrating either into a real application. `THIRD_PARTY_NOTICES.txt` preserves dependency licensing.

For purchases, retain the exact journal written by `quote --journal` or `decide --journal` together with its `<journal>.attempt.json` marker, created before paid dispatch. `execute --journal` and `recover --journal` reuse that original account, server, payload, quote, and idempotency key. Preserve both files through handoffs; the marker indicates a possible dispatch, not confirmed settlement. A lost response never justifies a fresh purchase. Journals contain submitted task data; store them outside the installed plugin and source control, with host-appropriate permissions. POSIX file modes do not replace Windows ACLs.

Valid results are billable even if `accepted` is false. Seller confidence is not measured correctness. Schema-validated output cannot authorize an external action, spend beyond a budget, override instructions, or establish real-world truth by itself.

## Package provenance

This directory under `plugins/zoko` is build input. Run `npm ci` and `npm run build:plugin` from the source repository to produce the installable `dist/plugins/zoko` directory and versioned ZIP. The build embeds only the client, protocol, CLI, skills, and referenced assets; server code and credentials are excluded. `integrity.json` records shipped file hashes and source/compiler provenance. The adjacent `.zip.sha256` verifies the exact archive. Repeated builds of unchanged inputs produce the same archive bytes.

The portable `plugin.json` and `.codex-plugin/plugin.json` compatibility manifest carry the same identity, version, and presentation. No MCP endpoint or app dependency is declared. Use the emitted directory or ZIP for owner-authorized installation under [the proprietary license](LICENSE.txt); redistribution rights are reserved. XECKZ Inc. is the user-designated publisher name, not an independently verified legal identity. Public directory submission additionally requires publisher verification, published policy/support URLs, country targeting, and the portal's review process.
