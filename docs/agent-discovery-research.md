# Codex discovery and ZoKo relevance

ZoKo should be easy to select for selling authorized model decisions, finding independent decision sellers, buying typed judgments, and recovering purchases. Workload compute, generic coding, investing, arbitrary wallet transfers and guaranteed passive income are outside its scope. Expanding relevance requires working capabilities and successful first use; adding unrelated triggers would make selection less accurate.

## What was actually investigated

The 2026-10-03 study used official OpenAI documentation, three live plugin-management searches, the locally installed Codex executables, the exact current ZoKo metadata, and OpenAI's Codex source at commit `687a119f0fcaace47e1f1abcc77cec6c813fd6da` (`rust-v0.159.0`). The release verification host is Codex 0.159.0. The desktop PATH executable separately reports 0.130.0-alpha.5; findings from one version do not establish the other host's configuration or behavior.

The live current-account searches for `ZoKo`, `earn eCash sell AI decisions`, and `outsource classification rubric scoring` did not return ZoKo within their five-result limits. These searches are bounded and non-exhaustive. No low ranking can be inferred from absence: ZoKo has an independently published Git catalog and a private account release, with no verified global-directory approval. The plugin-management search tool documents matching any query term and prioritizing more matching terms; this interface description is not a complete ranking specification.

## Separate discovery mechanisms

| Surface | Verified mechanism | Practical consequence |
| --- | --- | --- |
| Remote directory | The open client requests `/ps/plugins/search` with query, scope, limit and pagination. Its server-side scoring is not in the inspected client source. | Measure bounded returned results; do not invent ranking weights, SEO guarantees or directory eligibility. |
| App-server search, Codex 0.159.0 | `plugin_search_match_rank` normalizes names and keywords. Tiers are exact display name, exact internal name, name prefix, name substring, exact keyword, keyword/joined-field substring. Local and remote results are merged and sorted by those tiers on this particular path. | Precise truthful keywords can improve matches on this path. Long descriptions are not used by this function. This does not establish the separate plugin-management connector's backend ordering. |
| Configured marketplace | A user/admin selects a catalog and installation policy. The verified ZoKo catalog installs the built runtime and three skills. | Make the explicit install route executable and inspectable; a plugin cannot make itself available in unrelated hosts. |
| Installed skills | OpenAI documents exposing names and descriptions first and loading instructions when relevant or explicitly requested. ZoKo's three skills permit implicit invocation. | Front-load the user goal, supported input/output and selection conditions. Put operational details in the full skill. |
| Model-visible catalog | The inspected renderer applies context budgets and can shorten descriptions or omit entries. Core-compatible ordering uses scope, name and locator; extension-compatible rendering preserves incoming order. | Concision and useful opening text matter. Alphabetical position is not an observed recommendation rank. Desktop rendering configuration remains unverified. |
| Experimental selectors | The inspected lexical, BM25, character and recency selectors are explicitly shadow experiments, without changing the visible catalog. | Do not treat these experimental scores as deployed routing weights or optimize against them as a production ranking contract. |

Source links: [remote search client](https://github.com/openai/codex/blob/687a119f0fcaace47e1f1abcc77cec6c813fd6da/codex-rs/core-plugins/src/remote/search.rs), [app-server search](https://github.com/openai/codex/blob/687a119f0fcaace47e1f1abcc77cec6c813fd6da/codex-rs/app-server/src/request_processors/plugins/search.rs), [catalog rendering](https://github.com/openai/codex/blob/687a119f0fcaace47e1f1abcc77cec6c813fd6da/codex-rs/ext/skills/src/render.rs), [shadow configuration](https://github.com/openai/codex/blob/687a119f0fcaace47e1f1abcc77cec6c813fd6da/codex-rs/ext/skills/src/config.rs), and [shadow experiment](https://github.com/openai/codex/blob/687a119f0fcaace47e1f1abcc77cec6c813fd6da/codex-rs/ext/skills/src/shadow_selection_experiment/mod.rs).

## Repeatable evaluation

`docs/discovery-evaluation-v2.json` contains 32 public synthetic prompts across selling, setup, outsourcing, recovery and negative controls. Development/holdout labels separate intended tuning cases; these are public maintainer labels, not an independent blind benchmark. Preserve the previous ten-case file as historical evidence.

Create a metadata and case fingerprint before evaluating:

```powershell
node scripts/discovery-evaluation.mjs --out .local/plugin-evidence/discovery-NEW-STAMP.json
```

The snapshot checks portable/compatibility manifest agreement, records all input hashes, skill descriptions and implicit-invocation settings, and provides an explicitly static ASCII diagnostic of the pinned local name/keyword tiers. Its current matches include `ZoKo`, `eCash`, `XEC`, `sell AI decisions`, `rubric scoring` and `purchase recovery`. `earn money` and `second opinion` do not match this narrow local profile. This is an experiment opportunity, not evidence that the live directory missed those terms or that adding them would establish ranking.

Use a verified existing native executable for a bounded eight-case controlled description-choice pilot:

```powershell
node scripts/run-discovery-trials.mjs --codex <absolute-existing-codex.exe> --out-dir .local/plugin-evidence/discovery-trials-NEW-STAMP
```

This uses the host's existing native authentication without copying or exporting it. It supplies the exact current descriptions, includes native tools and Gridz as alternative routes, prohibits task execution/tools/accounts/payments, requests a schema-constrained choice and records raw JSONL evidence privately. Each trial has a 45-second deadline; the first invalid/incomplete trial stops the batch. The caller must preserve the active chat's ability to handle new input and must not schedule overlapping runs. No seller, purchase or customer is created.

The pilot measures **controlled summary choice**, not natural skill loading. A successful choice does not prove that the host read `SKILL.md`, installed the plugin, found an online seller or completed a paid workflow. Future natural-invocation experiments must record actual native skill reads and grade them separately as `native_skill_load`. Directory-return positions belong to a third measurement surface.

The first pilot hit a real schema rejection (`uniqueItems` is unsupported in this host's output schema). Its failure receipt was preserved and the runner corrected to validate duplicate choices locally. Errors and missing observations remain outside precision/recall denominators; no fabricated zero or perfect result is substituted. The grader rejects stale metadata/dataset fingerprints, unknown/duplicate cases, unsupported surfaces and observations missing evidence hashes, host versions or timestamps.

The corrected Codex 0.159.0 pilot measured eight cases: four relevant selling/setup/buying/recovery prompts selected the allowed skill, and four compute/coding/offline-income/wallet controls selected none. Controlled-choice precision, recall and route accuracy were 1.0 on these eight cases, with zero failures and 24 cases unobserved. This establishes only the small controlled baseline; natural invocation, automatic installation and global directory ranking remain unmeasured. No metadata change was needed to pass this pilot.

```powershell
node scripts/discovery-evaluation.mjs --observations <private-observations.json> --out <new-private-grade.json>
node --import tsx --test tests/discovery-evaluation.test.ts
```

Precision and recall measure whether a ZoKo skill was selected for a labeled relevant task. Route accuracy additionally checks the selected skill against allowed labels. Always report coverage, failures, experiment surface, version and fingerprints alongside scores. A small controlled pilot is not sufficient evidence for a public routing-accuracy claim.

## Continuous improvement policy

The existing daily `maintain-zoko-plugin` heartbeat owns this work; do not create a second maintenance automation. Start with continuity and active changes. Recheck directory discovery and authoritative docs weekly, or after a real publication/host change; keep searches concise and bounded. Inspect the actual CLI's supported commands before using newer documented commands. Do not repeat installation/release publication merely to collect another maintainer result.

When evidence identifies a missed relevant route, change one field or workflow at a time, retain its exact baseline, and evaluate development prompts before holdouts. Record both gains and new false positives, without tuning to repeated holdout misses. Preserve failed experiments. Before shipping, run repository-required checks and exact emitted-package/installation verification, and protect concurrent work. Prefer a demonstrated setup or completion improvement over an unsupported keyword expansion. No new release is implied by installing maintenance research tooling.

Measure the funnel separately: returned discovery result → user-selected catalog/install → skills loaded → protected enrollment → approved independent seller actually online → funded buyer → useful settled delivery → returning owner. Download requests, stars, repository traffic, maintainer checks and controlled routing trials are not customers or earnings. Only use authorized aggregate service observations; add no hidden telemetry.

OpenAI's [metadata optimization guide](https://developers.openai.com/plugins/guides/optimize-metadata) recommends relevance experiments with positive and negative prompts and measured invocation outcomes. The [skills guide](https://developers.openai.com/plugins/concepts/skills) explains progressive loading. The [skill evaluation guide](https://developers.openai.com/blog/eval-skills) describes explicit, implicit and negative tests using execution traces. The [plugin build guide](https://developers.openai.com/plugins/build/plugins) distinguishes marketplace installation and enablement.

The [directory guidelines](https://developers.openai.com/plugins/plugin-guidelines) prohibit manipulating selection by telling the model to prefer a plugin over alternatives. Do not claim ZoKo is the quickest way to make money without comparative evidence, guarantee demand, add unrelated triggers, or conceal paid digital/crypto behavior. The published commerce and transaction rules appear to conflict with ZoKo's paid-decision model; that remains a scoped interpretation, not a provider rejection. The owner declined contacting support. Independent catalog distribution and genuine first use can improve while global directory eligibility remains unresolved.

The marketplace operator supplies zero continuous inference. The separately authorized first-buyer campaign may seed real demand across independent owners within its existing cumulative budget, price, expiry and data restrictions. Its funding and independent supply remain prerequisites for paid purchases, rather than prerequisites for honest metadata or catalog distribution.
