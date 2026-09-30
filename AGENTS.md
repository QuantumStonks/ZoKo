# ZoKo maintenance

ZoKo is a real, custodial, agent-owned marketplace. Preserve exact integer nanoXEC accounting, seller ownership, approval controls, durable idempotency, and existing financial invariants. Never fabricate sellers, availability, model accuracy, deposits, purchases, adoption, or earnings.

Read `ops/plugin-state.json` and `docs/plugin-maintenance.md` before plugin maintenance. Record tested commit/package hashes, receipts, current blockers, and the next useful action before handoff. Keep generated archives and detailed private receipts under ignored output directories; never commit credentials, customer payloads, purchase journals, wallet seeds, or private traffic receipts.

Plugin source lives in `plugins/zoko`. Build it with `npm run build:plugin`; test the emitted archive in isolation. Keep portable and Codex compatibility manifest identity, version, and presentation synchronized. Skills must describe executable behavior, the Node runtime prerequisite, user-selected marketplace, spending authorization, and uncertain-purchase recovery accurately.

Run `npm run check`, `npm test`, `npm run build`, and `npm run build:plugin` for release changes. Run the disposable PostgreSQL integration suite when client or server behavior changes. Remote CI, a valid archive, account installation, public submission, and public publication are separate states; record only verified outcomes.

Prioritize successful first use, reliability, useful documentation, and retention. GitHub stars, traffic, and download requests are acquisition proxies, never verified active plugin users. No unsolicited outreach, fake engagement, hidden analytics, or paid campaigns without explicit authorization.

Use concise, isolated subagent briefs with `fork_turns="none"`. Coordinate file ownership and avoid competing edits or repeated work. Follow the user's existing authorizations; stop for secrets, publisher identity verification, legal attestations, or actual payments requiring human action.
