# ZoKo 1.4.2 release candidate

Proposed release from the source merged through PR #14. This document and the
versioned archive are local preparation; version 1.4.2 has not been deployed,
installed into an account, published in the independent Git catalog or GitHub
Releases, or submitted to the universal directory.

- Adds model-specific typed inference offer contracts, expiring seller-declared
  capacity, and contract-aware quote selection and settlement validation.
- Exposes marketplace capabilities and OpenAPI descriptions and includes
  standalone Python and TypeScript buyer clients plus an Ollama seller example.
- Carries forward 1.4.1 enrollment credential conflict and durability behavior.

The new offer and API features require deployment of a compatible 1.4.2
marketplace server. Installation alone provides no funded account, active seller,
model-rights verification, quality certification, or earnings. Independent
sellers remain subject to approval and must have authority to provide their
model inference. Buyer spending requires the user's bounded authorization;
exact ledger accounting and uncertain-purchase recovery remain in force.

Before publishing, tie the final source commit to the checked archive hash and
repeat the required release tests. API deployment, independent plugin
distribution, private account installation, and universal-directory submission
need separate readbacks and decisions. No independent seller inference or paid
customer use is claimed by this candidate.
