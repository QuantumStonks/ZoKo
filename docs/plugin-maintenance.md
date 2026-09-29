# Plugin ownership and measured improvement

ZoKo's adoption objective is more agents completing useful, authorized buyer and seller work and returning successfully. A top marketplace position is an ambition, not an observed rank or a guarantee. Paid workflows depend on an actual ZoKo marketplace, funded buyer accounts, and approved seller endpoints. Those services are separate from publishing or installing the plugin; distributing a package does not supply them.

## Durable operating record

Start each maintenance cycle with `ops/plugin-state.json`, the current branch/diff, the latest test and package receipts, and any active work on the same files. Claim one concrete work item before editing. Update the state before handoff with the source revision, exact artifact hash, commands and results, current distribution state, blocker, and next useful action. Keep raw logs and metrics in protected `.local/` storage; commit only compact, non-sensitive receipts needed for continuity.

Keep these outcomes separate: package built, package validated, locally installed, independent Git catalog published and remotely installed, private account plugin created, universal-directory draft uploaded, submitted for review, approved, and publicly listed. Record the provider ID or readback when available. A local installation does not establish anyone else's installation or public discoverability. A tool success does not establish successful end-user behavior without a readback or exercised workflow.

Independent personal, Git/npm, and workspace catalogs are distinct from the universal ChatGPT/Codex directory. Keep discovery within a configured catalog, installation on a host, skill pickup in a new chat, and global directory recommendations separate. Ship the built runtime in any catalog export; the repository's `plugins/zoko` directory alone is incomplete build input. Check actual host command support before using commands from newer documentation. The app-bundled CLI observed on 2026-09-29 was older than the stable published CLI.

The user declined sending the policy inquiry in `docs/plugin-policy-review.md`. Keep it unsent and do not contact support without new explicit authorization. The apparent universal-directory commerce conflict is not evidence against the separately documented independent Git marketplace route; continue useful work on that route while preserving truthful commerce disclosure and proprietary rights.

## Repository indicators

The dependency-free collector uses the installed GitHub CLI's existing authentication and sends only GET requests to `github.com`:

```powershell
$stamp = Get-Date -Format 'yyyyMMddTHHmmss'
npm run plugin:metrics -- --out ".local/plugin-metrics/$stamp.json"
```

The default repository is `QuantumStonks/ZoKo`; use `--repo OWNER/REPO` for an explicit alternative. For machine-readable stdout without npm's command banner, invoke `node scripts/plugin-metrics.mjs`. No `--token` option exists. The process captures diagnostics, disables GitHub debug output, and emits only normalized numeric fields, timestamps, repository identity, and enumerated error reasons. It never queries a ZoKo service or financial endpoint. Receipt files use exclusive creation, so an existing path is not overwritten. Mode `0600` is requested; on Windows, use a directory with appropriate account ACLs.

Each receipt contains `observationStartedAt`, `observedAt`, per-source observation times and endpoint paths, and a `coverage` value. Endpoint `status: available` means its validated `data` was read. Endpoint `status: unavailable` has `data: null` and a reason; it never becomes a fabricated zero. A real zero from a successful API read remains zero. These are successive requests, not a transactional snapshot.

| Indicator | Exact interpretation |
| --- | --- |
| `repository.data.stars`, `forks` | Repository interest across the entire ZoKo project. |
| `repository.data.openIssuesAndPullRequests` | GitHub repository `open_issues_count`, which includes open pull requests. |
| `openIssues.data.count` | Open issues only, from an exact repository search with `is:issue is:open`; an incomplete search is unavailable. |
| `releases.data.publishedCount` | Published releases visible to the authenticated caller, including prereleases; drafts are excluded. |
| `releases.data.assetDownloads` | Sum of download counts across assets on those releases; not unique downloaders, plugin installations, or generated source archive downloads. All releases and assets are paginated. Numeric release/asset IDs preserve attribution without copying release text. |
| `traffic.views`, `traffic.clones` | GitHub's rolling 14-day counts, window uniques, and daily records. These cover repository activity, including automation. |
| `pluginAdoption` | Install, activation, completion, retention, and rank values remain `null` until an authoritative adoption source exists. |

Traffic access can be unavailable even when the public repository is readable. `authentication_required`, `forbidden`, `not_found_or_inaccessible`, `rate_limited`, `network_error`, and `timeout` describe distinct observations. A 403 is not proof that a specific permission is missing; GitHub's traffic endpoint requires suitable repository access and token permissions. Do not broaden credentials automatically merely to fill a dashboard. API pagination is capped at 100 pages per collection, requests at 15 seconds, and the collection at 60 seconds. Hitting a cap makes the affected aggregate unavailable instead of silently returning a partial total.

Exit `0` means the core repository endpoint succeeded; secondary metrics may still be unavailable, so inspect `coverage`. Exit `1` means core repository data is unavailable. Exit `2` means invalid arguments or an output/collector failure. JSON can still identify secondary failures without failing a maintenance cycle that has useful independent work.

Compare immutable receipts from known times. Do not add overlapping 14-day totals. For daily trends, deduplicate by endpoint and UTC date, prefer the latest observation for each date, and identify days that have fallen outside the collection window. Never add daily unique counts to claim period-unique users. Deleted releases/assets and changed visibility can decrease totals; a negative difference needs explanation, not clipping to zero. Attribute a download to the plugin only after matching its asset ID to the exact plugin archive and hash in release evidence.

The initial live read on 2026-09-29 at 19:45:54 UTC returned HTTP 200 for all five sources: 0 stars, 0 forks, 0 open issues, 0 published releases, 0 release assets/downloads, and 0 views/clones in GitHub's reported window. This is a dated repository baseline. It says nothing about plugin installs, active agents, demand, or marketplace rank.

API semantics: [GitHub traffic](https://docs.github.com/en/rest/metrics/traffic), [release endpoints](https://docs.github.com/en/rest/releases/releases), and [GitHub CLI API behavior](https://cli.github.com/manual/gh_api). The collector pins GitHub REST version `2026-03-10`.

## Measure actual adoption when evidence exists

This package adds no usage beacon. Before adding event collection, establish the actual data flow, user notice/choice, retention and deletion policy, and a source that can distinguish consented user cohorts without sending prompts, credentials, journals, financial balances, or wallet data. Prefer aggregate platform-provided adoption exports if available. Do not infer an official marketplace analytics API or invent install counts.

| Outcome | Definition and denominator |
| --- | --- |
| Installation | Distinct installs reported by an authoritative distribution source, with source, time range, version, and its deduplication definition. |
| Activation | For a defined installation cohort, the fraction completing the first intended supported workflow. Track successful connection separately from buyer or seller activation. An empty catalog response is successful diagnosis, not a completed purchase. |
| Buyer completion | An authorized task yields a terminal, schema-valid purchase receipt and an answer usable for the stated task. Keep `accepted: false`, failed, and indeterminate results separate. Denominator: explicitly initiated, authorized buyer tasks in the same cohort. |
| Seller activation | A real active-agent or HTTPS endpoint offer is registered, approved, and eligible. Keep registration, approval, presence, first validated delivery, and first sale as distinct stages. |
| Retention | Activated agents completing another useful workflow within a defined window, such as days 7–13 after activation, divided by the original activated cohort with that full observation window. |
| Reliability | Successful supported attempts / supported attempts, with failure category, package version, and environment. Recovery success and duplicate-purchase prevention are separate guardrails. |

Exclude maintainer checks, controlled test fixtures, known automation used only for validation, and incomplete observation windows from adoption claims. Report sample sizes and raw numerator/denominator with each rate. If identity/deduplication is unavailable, report observed workflow events instead of unique users. Never claim statistical improvement from tiny samples or from a changed denominator.

## Narrow growth roadmap

1. **Make installation and setup work.** Verify the exact ZIP and hash, Node 24 startup in an unrelated working directory, all skill links and assets, credential handling, and clear diagnosis of missing server/account/eligible seller. Deliver a concise public landing page and installation guide that state these prerequisites before asking users to invest time. Observe setup failures before choosing the next change.
2. **Prove one useful buyer path and one seller path.** Once a real test environment and authorized accounts exist, exercise connection → bounded purchase → receipt/recovery and endpoint integration → registration → approval → actual delivery. Record the precise version and results. A controlled server test proves the client contract, not production seller quality or live settlement.
3. **Remove the largest evidenced completion failure.** Choose one measured problem, state the expected effect, ship a bounded fix, and compare like-for-like attempts. Prioritize error clarity, recovery, task/result fit, and predictable cumulative spending over decorative features. Treat a result as inconclusive if the sample or coverage is insufficient.
4. **Earn repeat use.** Add workload-specific guidance only for actual observed tasks and verified endpoint contracts. Preserve standing authorization, journals, seller restrictions, and remaining task budgets through session recovery. Measure retained cohorts only after the full window has elapsed.
5. **Expand distribution from proof.** Publish accurate installation material, release notes, workload evidence, and a finished listing through authorized project channels. Track discovery separately from activation. Do not fabricate reviews, install counts, performance, partnerships, or a rank; do not send unsolicited outreach, messages, or spam.

For each experiment, record the user problem, evidence/source, hypothesis, exact change/version, eligibility/denominator, outcome metric, guardrails, observation window, and stop/revert condition. Keep one primary experiment per bottleneck so a result is interpretable. Review other approaches when improvements stop helping; a broader feature set is not inherently better than resolving the demonstrated blocker.

## Maintenance cadence and validation

Run the owner's configured maintenance cadence against the durable state. If repository metrics are needed, one collection per cycle is sufficient; repeated polling is not progress. Keep quiet when there is no meaningful change and no useful independent action. Notify on a fixed failure, a verified release/installation change, an actionable regression, or a concrete human-only requirement. A denied traffic read can coexist with useful package, documentation, or regression work.

Before a release, run the applicable type checks, unit/integration tests, and isolated plugin build tests; validate emitted manifests, references, file inventory, asset dimensions, archive safety, and exact hashes. Check the bundled CLI from an unrelated working directory with its supported Node version. Re-run tests only for new changes, failures, or an unresolved concern. Record test fixtures as fixtures and live acceptance as live acceptance. Do not spend funds, sign a transaction, or contact third parties merely to improve a test score or a metric.

Keep `docs/plugin-listing.md` and package metadata aligned. Review actual task scope and standing authorization before taking an action. Continue autonomously within the authorized task, cumulative budget, seller/data restrictions, and time window; do not request fresh permission for each already authorized action. Pause only when authorization is absent or exceeded, a genuinely missing fact prevents correct execution, or the host enforces a human action. Unknown credentials, verified legal publisher identity, and provider attestations cannot be manufactured by maintenance work. Scope provider company verification and directory attestations to universal-directory submission, and real service, seller, account, and spending prerequisites to the workflows that require them; neither is a blanket blocker for the independent catalog release.

The owner authorized public distribution under XECKZ Inc. while retaining proprietary rights on 2026-09-29. Official unmodified plugin releases may be downloaded, installed, and executed for authorized work under their included license without individual permission; modification, redistribution, sublicensing, and sale rights remain reserved. Continue authorized distribution work without another publication approval. The Git catalog ref `codex/zoko-marketplace` is published with verified public ref readback; isolated Codex 0.159.0 anonymously cloned and installed version 1.3.0 with all 22 package files and all three skills enabled without loader errors. See `docs/plugin-marketplace.md` for the exact published commit and receipt, and `ops/plugin-state.json` for current test evidence.

The owner subsequently authorized connecting Render, a preferred $30/month hosting budget with a $50 fallback, and use of each active Codex instance's own session for inference. Node.js 24 is installed. Version 1.3.0 adds owner-bound queued jobs, expiring active presence, durable claim/result journals and the existing exact-once settlement path; it neither exports Codex authentication nor creates a public Codex execution endpoint. Per-job native token usage remains unavailable. The managed hosting preparation is `render.yaml` with [deployment and acceptance instructions](render-deployment.md); its published-schema validation is not resource creation. The prepared resources cost $45.75/month before tax and usage overages. The delegated cumulative mainnet acceptance cap is 200 XEC with one decision at no more than 10 XEC. Render installation has reached its OAuth sign-in page but connection remains unverified. Account sign-in, protected secrets with verified encrypted recovery backup, and the funding-wallet choice remain pending. Do not ask again for these supplied budgets or a separate inference API account. Both configured public Chronik hosts passed read-only chain/checkpoint/fresh-tip/token-index observations; those reads prove neither service wallet backup nor live deposit, sale or withdrawal. Keep exact receipts, current distribution versions and file hashes in `ops/plugin-state.json` and ignored `.local/plugin-evidence/`.

Universal-directory eligibility remains unresolved: the current [OpenAI commerce rules](https://developers.openai.com/plugins/plugin-guidelines) prohibit digital-service commerce, whereas ZoKo charges for AI decisions. Preserve a truthful commerce declaration and the user's paid product requirements. Do not repeatedly attempt directory submission, conceal payments, or silently remove paid functionality. Revisit that directory gate only when an authoritative policy change, provider response, or explicitly approved product-scope change supplies new evidence. See `docs/plugin-policy-review.md` for the declined, unsent clarification draft.
