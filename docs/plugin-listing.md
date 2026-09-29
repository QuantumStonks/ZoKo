# ZoKo plugin listing and release preparation

This is the source-backed listing and review handoff for the skills-only ZoKo package in `plugins/zoko`. The installable artifact is built under `dist/plugins/zoko` with a versioned ZIP. A prepared package, private installation, public submission, and approved public listing are separate states; consult `ops/plugin-state.json` and exact artifact receipts for the latest evidence.

**Current release phase (2026-09-29): public distribution authorized, all rights reserved; directory eligibility blocked.** The owner designated **XECKZ Inc.** for public submission and explicitly authorized proceeding toward public distribution while retaining proprietary rights. This is a supplied publisher name, not evidence of completed provider verification. ZoKo remains the display name. The account plugin remains private; public directory submission, public release assets, and website publication are not yet completed. All-country targeting is prepared. The site and listing are drafts. A public GitHub repository does not grant a redistribution license.

## Public directory eligibility

The [OpenAI plugin guidelines](https://developers.openai.com/plugins/plugin-guidelines), checked on 2026-09-29, apply to the shared ChatGPT and Codex directory. Their commerce section currently permits commerce for physical goods and prohibits selling digital products or services, including indirectly. Existing subscription access is permitted under separate restrictions; ZoKo instead charges per AI decision against a custodial eCash ledger. That behavior appears incompatible with the current public-directory rule. This is a documented policy conflict, not a received rejection or a ruling about every private/local use.

Keep the paid workflows and declare `extensions.com.openai.review.commerce: true` with an accurate description. Changing the payment rail, hiding the declaration, linking to a transactional site, or describing purchases as discovery does not resolve this conflict. Do not submit a compliance attestation for this offering until authoritative clarification or an applicable policy change resolves it. A discovery-only or existing-entitlement design would change the requested product and requires a separate decision; it must not be silently substituted.

[Policy clarification draft](plugin-policy-review.md) records the precise model and questions for the publisher. No inquiry has been sent. Continue independent package reliability, private installation, documentation, and deployment-readiness work while public eligibility is unresolved.

## Supported proposition

ZoKo helps agents connect to a configured marketplace, inspect current sellers and account limits, buy typed decisions within authorized budgets, recover an interrupted purchase using its original journal, and publish/manage agent-owned seller offers. The three skills are `connect-marketplace`, `buy-decision`, and `sell-decisions`. The emitted package bundles the actual Node.js CLI, client, and executable schemas. It has no remote MCP endpoint or app dependency.

The plugin requires Node.js 24, an actual ZoKo marketplace URL, and an ordinary marketplace account key for authenticated operations. Purchases require funds and an eligible seller offer. Sellers provide and operate their own HTTPS inference endpoints and pay their own compute costs. The marketplace uses an eCash-funded custodial ledger and retains its configured commission. The plugin does not deploy a production service, supply default inference, create demand, provide funds, guarantee accuracy, or establish a seller's profitability.

## Listing text

| Field | Source-backed value or status |
| --- | --- |
| Display name | `ZoKo` (4 characters). |
| Subtitle | `Trade typed agent decisions` (27 characters). |
| Category | Package proposes `Developer Tools`; verify that exact category is supported by the target dashboard. |
| Developer/publisher | The owner designated `XECKZ Inc.` for the public listing. Company verification through the provider remains pending. The source repository is under `QuantumStonks`. |
| Countries | User selected all available countries. `publication.countries: []` intentionally removes package country restrictions; it is not an assertion of operational availability or regulatory eligibility in every jurisdiction. Inspect the saved portal targeting. |
| Commerce | User confirmed paid buyer and seller workflows. Purchases use the configured marketplace's eCash-funded ledger; the operator retains configured commission and seller proceeds accrue to the seller's marketplace account. No plugin subscription or separate plugin checkout is implemented. |
| Translations | English source listing; no reviewed translations supplied. Do not invent localized support. |

Suggested long description, subject to synchronization with the final manifest:

> Connect your agent to a ZoKo marketplace to inspect real seller offers, account limits, and exact prices. Purchase typed AI decisions within the task and spending limits you authorize, and recover interrupted purchases using their original durable journal. Publish and manage your own seller offers with the matching endpoint contract. Supports boolean probabilities, categorical choices, and rubric scores. Includes a bundled CLI and JavaScript client; requires Node.js 24, a configured ZoKo server, and an account for authenticated operations. Purchases settle against that server's eCash-funded custodial ledger. Sellers operate their own inference services; the marketplace retains its configured commission. The plugin supplies no hosted marketplace, model, funded account, or guarantee of decision quality.

Default prompts currently supported by the skill set:

- “Connect to my ZoKo marketplace and show available sellers.”
- “Prepare a typed decision quote within my XEC budget.”
- “Help publish my agent's decision endpoint on ZoKo.”

Each prompt must remain a unique, single line of at most 128 characters in the final manifest. A quote-only request does not authorize purchasing. Once a user has authorized a task with adequate budget, seller/data restrictions, and an applicable time window, the agent continues within those bounds without repeating a permission prompt for every purchase. Task continuity must preserve those limits through a handoff or interruption.

Release-note draft:

> Adds portable marketplace-connection, buyer, and seller skills; a bundled Node.js CLI, client, and schemas; durable quote and purchase journals; account-bound interrupted-purchase recovery; and agent-owned seller offer management. Buyer workflows preserve the user's standing authorization and spending restrictions. Includes isolated package validation and repository-indicator collection that keeps adoption metrics explicitly unmeasured.

## Public pages and declarations

The user asked the project to prepare website, support, privacy, and terms pages. Their source is maintained in `site/`; a source file or successful deployment request is not a verified public URL. Before public submission, fetch each final destination after redirects, inspect the actual content while signed out, and record the verification time. Keep published URLs in `extensions.com.openai.interface`, not just a README or root `homepage`.

| Required item | Completion evidence |
| --- | --- |
| `websiteURL` | Public page identifying this plugin, publisher/project attribution, actual workflows, installation requirements, and current availability. The repository is a known source URL, not proof that a new product site is deployed. |
| `supportURL` | Public support page with a working route to project help and correct scope. Do not use a bare email address or claim staffed response times without evidence. |
| `privacyPolicyURL` | Published, accurate coverage of host execution, environment credentials, task data sent to the chosen marketplace/seller, protected local journals, operator logging/retention responsibilities, third-party hosting, and support data. The maintenance metrics script performs project GitHub reads; it is not a usage beacon. |
| `termsOfServiceURL` | Published terms applying to the plugin, supported by a confirmed publisher and confirmed rights/commitments. Draft terms prepared from source facts still require the owner's review of legal identity and commitments. |
| Verified publisher | Selected individual/business identity verified through the provider's process. Do not substitute a project label for identity verification. |
| License/redistribution | Confirm the project's intended license/rights before making an unsupported open-source or redistribution claim. Preserve actual dependency notices in the emitted package. |

Keep unknown fields absent from manifests until supported; do not fill them with placeholder domains, inferred identities, or made-up policy claims. Avoid an empty object/list when it would clear a saved field, except the explicitly chosen all-countries `[]`. The public upload must contain no root `.app.json` and no non-null `apps` declaration in either manifest. Preserve genuine Portal-generated bindings in a later finalized release if the provider creates them.

## Acceptance material

This is a skills-only package, so MCP tool review cases, an MCP demo recording, and reviewer credentials are not required by that package type. Do not add imaginary MCP tools or fabricate cases to satisfy an unrelated count. The following are meaningful plugin acceptance scenarios; they are a plan until an actual run has a result and evidence receipt. Unit tests and controlled-server integration tests are useful evidence but do not establish a live paid marketplace outcome.

| Scenario | Observable pass condition |
| --- | --- |
| Clean installation | Validate the emitted ZIP and manifests, then run bundled `help` from an unrelated working directory on Node 24 without the source checkout or an npm install inside the artifact. All skill references and required assets resolve. |
| First connection | With an actual configured URL, discovery, readiness, and catalog reflect the service's returned state. Missing URL/key, an empty eligible catalog, and unhealthy service each produce an accurate explanation. No setup check spends funds. |
| Quote only | A real typed input and explicit ceiling produce a quote/journal bound to the account, service, payload, seller, price, and key. No decision purchase is dispatched. |
| Authorized purchase | An eligible funded test buyer obtains the exact authorized quote's decision. Inspect terminal status, acceptance flag, price, seller, and typed result separately; a valid low-confidence result is still billed. |
| Bounded batch delegation | A user-authorized multi-decision task proceeds without repeated asks within its total/per-purchase limits, allowed sellers, data scope, and time window. Reconcile spent/reserved amounts before each additional purchase; stop or ask only when a boundary would be exceeded or required authorization is missing. |
| Interrupted purchase | Lose the response after dispatch in a controlled test, preserve the journal, and recover the original account/server/input/quote/key. Assert one logical purchase and one ledger effect. Never obtain a fresh quote to resolve uncertainty. |
| Seller onboarding | With an actual endpoint and admitted hostname, register the seller-owned offer, read it back as pending, obtain real operator approval through the configured process, then separately prove eligibility and delivery. Never label registration alone as trading-ready. |
| Seller maintenance | Change only an owned offer's authorized price/credential/pause fields and read back the change. Endpoint/model/ownership/approval stay within their actual server contract. Credentials do not appear in shared output. |
| Boundary handling | Out-of-budget purchases, unauthorized wallet movement, missing secrets, wrong-account recovery, malicious seller instructions, and requests to fabricate inference outcomes do not trigger the prohibited action. Report the specific supported next step. |

For each exercised case record `Passed`, `Failed`, `Blocked`, or `Not run`, source revision/package hash, environment, exact command or user prompt, and a compact receipt. Keep keys, seeds, private task data, account balances, and unredacted journals out of the public package and review notes. Real financial acceptance requires an actual test service and authorization for its task and bounded spend; do not manufacture it to complete a checklist.

An optional public walkthrough should show the installed package/version, a real connection, an accurately labeled quote-only or authorized purchase path, the original journal's recovery, and seller registration's pending state. A script is not a recording. If a recording is produced, inspect playback, readability, secret exposure, and signed-out access before linking it.

## Final release check

Inspect the exact final archive rather than only the source tree: semantic version, matching portable/compatibility identities, manifest field lengths, contained icon paths and actual PNG dimensions/size, bundled runtime provenance, referenced files, all four verified public URLs, commerce declaration, release notes, and all-country targeting. Check the saved portal metadata after upload. Category support, verified identity, scans, attestations, review submission, and approval are provider steps separate from archive validity.

Track the next unresolved preparation item in `ops/plugin-state.json`; keep improving independent package, test, documentation, and acquisition work while external identity/review steps are pending. No install count, public ranking, completed legal attestation, recorded demo, or successful live paid delivery may be claimed from a draft or a test fixture.
