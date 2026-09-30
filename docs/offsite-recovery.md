# Independent recovery and encrypted replication

ZoKo's hourly age-encrypted database snapshots are working. A separate replicator
is implemented, but **not configured or enabled** until an owner-approved storage
destination and its restricted credentials are supplied. A local backend rehearsal
does not establish off-site protection. The portable configuration/account-key
bundle must also be copied to the independent destination; hourly database copies
alone cannot recover the wallet configuration after total server loss.

## Destination and access

Use an independently hosted private object-storage bucket with versioning and
provider-enforced retention/Object Lock where supported. Restrict the dedicated
backup credential to reading, listing and creating objects in one ZoKo prefix;
deny deletion and retention bypass. Configure provider lifecycle expiry separately
under the owner's retention and storage budget. The program never calls sync,
delete, purge, move or overwrite. Rclone's `--immutable` is a client-side safeguard,
not protection against a compromised uploader credential or provider deletion.

Install a verified rclone release as `/usr/local/bin/zoko-rclone`, owned by root
and mode 0755. Use a separate static storage credential in
`/opt/zoko/secrets/offsite-rclone.conf`, with a named remote `zoko-offsite`.
Keep the file readable only by its owner (0400 or 0600). Do not reuse credentials
from Gridz or other projects and do not export desktop connector credentials.
The server receives only the storage credential and public age recipient.
**Never upload the private recovery identity to the server or the storage bucket.**

The owner must store the identity independently of both the VPS and this desktop,
for example in their existing secure offline custody. Test fresh-process decryption
using that independent copy and record the ciphertext and plaintext hashes. A copy
in another folder on this desktop does not satisfy independent custody.

## Install without touching the marketplace runtime

Create a locked system user/group `zoko-backup` without a login shell. Place
`scripts/replicate-encrypted-backups.mjs` and `scripts/verify-encrypted-backup.mjs`
in root-owned `/opt/zoko/backup-tools/`. The latter supplies bounded metadata
validation; the replicator does not invoke its decryption function.

Grant the group traversal of `/opt/zoko`, `/opt/zoko/backups` and the secrets
directory (group execute only, not a directory listing or secret-file read grant).
The off-site rclone file is owned by `zoko-backup`; the marketplace service-wallet
configuration retains its existing root-only permissions. Grant read/traverse
access only to `/opt/zoko/backups/encrypted` (0750, group `zoko-backup`). Keep
snapshot files/sidecars root-owned, group `zoko-backup`, mode 0640. The producer's
tracked `ops/zoko-encrypted-backup.sh` grants these modes only when the dedicated
group exists; its backup process remains unchanged. The replicator must have no
permission to change the producer directory. Give its own receipt directory
`/opt/zoko/backups/offsite` to `zoko-backup`, mode 0700.

Create `/opt/zoko/secrets/offsite-backup.env`, mode 0600 and root-owned, containing
the approved `ZOKO_OFFSITE_DESTINATION` named-remote bucket/prefix. Install the
service/timer from `ops/zoko-offsite-backup.*`. The service cannot access the
service-wallet configuration or Docker socket and can write only its receipts and
private temporary ciphertext. Do not enable the timer before the first real
remote readback and independent custody test succeed.

```bash
sudo systemctl start zoko-offsite-backup.service
sudo systemctl show zoko-offsite-backup.service -p Result -p ExecMainStatus
sudo systemctl enable --now zoko-offsite-backup.timer
```

These commands require the configured destination; they are not a completed
deployment claim. The timer retries every fifteen minutes without a desktop.
Check service result, latest receipt age, latest hourly snapshot coverage and remote
availability during daily maintenance. Provider failure is an operational failure,
not permission to change storage accounts or increase spending automatically.

## Replication and recovery evidence

The producer writes an exclusive `.dump.age.json` sidecar for each snapshot before
advancing `latest.json`. The replicator recognizes only timestamped `.dump.age`
files in its exact root, validates binary age headers, sizes and SHA256 hashes,
then stages the bounded ciphertext. It rejects symlinks and mismatched metadata.
Only validated ciphertext and a constructed metadata subset are uploaded. Unknown
source metadata fields, private identities, plaintext and database connections are
never passed to rclone. Backend diagnostics are suppressed; secrets stay out of
arguments and receipts. Each process has a 60-second deadline and bounded output.

Objects use a ciphertext-hash prefix. Before uploading, the replicator reads any
existing object fully and compares size/SHA256. A mismatch stops without replacement.
After uploading with `copyto --immutable --checksum`, full remote readback must
match before an exclusive success receipt is written. A failed or ambiguous upload
remains retryable under the same object name. Receipts are preserved, and the newest
snapshot is read back again on every wakeup. Each cycle also drains up to 23 older
unverified snapshots from the retained backlog. Older receipts prove their recorded
readback time only; they do not prove perpetual provider retention.

The script's exclusive `replication.lock` prevents competing jobs. If a process is
forcibly killed, inspect the service state and lock's PID/time before removing that
one stale lock. Never remove a lock belonging to a live process. Remaining staged
`.replicate-*` directories contain ciphertext only; remove only those owned by a
confirmed stopped run. Do not alter financial journals or backup originals.

For a portable recovery, retrieve the matching ciphertext and sanitized `.json`
metadata from storage, then invoke the tracked streaming verifier **on an independent
recovery machine** using the separately held private identity. Successful decryption
does not replace an isolated PostgreSQL restore and ledger audit. Retain exact
remote readback, decryption, restored-schema and ledger receipts separately.
