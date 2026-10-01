# Independent recovery and encrypted replication

ZoKo produces hourly age-encrypted database snapshots. The owner authorized a
private Falkenstein Hetzner Object Storage bucket, 30-day COMPLIANCE Object Lock,
separate local administrator credentials and a restricted VPS uploader on
1 October 2026. The uploaded full portable database, service configuration and
account-key bundle passed exact remote readback and fresh-process decryption.
The independent key copy remains in the owner's private Google Drive account.
The isolated replication timer is enabled every 15 minutes. All 24 initial
hourly snapshots passed remote readback, and the newest remote snapshot passed
fresh-process decryption. Exact activation, installed hashes, Object Lock and
timer receipts are recorded in `ops/plugin-state.json`.

## Destination and access

Use an independently hosted private object-storage bucket with versioning and
provider-enforced retention/Object Lock where supported. Restrict the dedicated
backup credential to reading and creating objects in the approved ZoKo prefixes;
deny deletion and retention bypass. Configure provider lifecycle expiry separately
under the owner's retention and storage budget. The program never calls sync,
delete, purge, move or overwrite. Rclone's `--immutable` is a client-side safeguard,
not protection against a compromised uploader credential or provider deletion.

The deployed bucket uses a dedicated project. Its uploader key belongs to a
different empty project and can list only the dedicated ZoKo bucket; object
read/write grants cover `zoko/database/*` and `zoko/recovery/*`. Listing the bucket
also permits S3 to distinguish missing objects from access-denied responses.
The local administrator has an explicit recovery-read grant for uploader-owned
objects. Actual denial checks cover deletion, retention bypass, bucket policy
access and writes outside the approved prefixes. The bucket is private,
versioned and protected against bucket deletion. Default retention and each
tested object's COMPLIANCE mode/retain-until timestamp were read back through S3.
No lifecycle deletion has been configured; locked objects are retained for at
least 30 days, not automatically erased on day 30. The full configuration bundle
must be refreshed after independently authorized service/account key changes.

Falkenstein storage is separate from the Nuremberg VPS and does not depend on
the laptop being online. Both resources remain under one Hetzner provider/account;
this is not protection against losing that entire provider account. The key copy
uses a different provider. The verified account's Object Storage base maximum is
EUR 7.85/month including VAT; shared VPS plus IPv4 and storage total EUR 27.81/month
before excess storage/traffic. At the 30 September ECB rate this is about USD 31.58,
within the owner's USD 50 fallback ceiling. Monitor actual usage and exchange rates.

Install a verified rclone release as `/usr/local/bin/zoko-rclone`, owned by root
and mode 0755. Use a separate static storage credential in
`/opt/zoko/secrets/offsite-rclone.conf`, with a named remote `zoko-offsite`.
Keep the file readable only by its owner (0400 or 0600). Do not reuse credentials
from Gridz or other projects and do not export desktop connector credentials.
The server receives only the storage credential and public age recipient.
**Never upload the private recovery identity to the server or the storage bucket.**

The private identity now has an independently stored copy in the owner's connected
Google Drive account, in a newly created private custody folder. Folder and file
permissions were read back as one owner and no sharing. Downloaded identity bytes
matched the protected original, and that downloaded copy decrypted the real
11:00 UTC Linux backup in a fresh process with matching ciphertext/plaintext
hashes. No identity or decrypted database was sent to the VPS. Exact private
location and receipts are under ignored `.local/plugin-evidence/`.

This is cloud account custody independent of the VPS and laptop, not an offline
hardware copy or proof that account recovery will work after loss of all sign-in
factors. Keep ciphertext storage separate from this custody account; do not put
encrypted wallet/database bundles into the key folder. A copy in another folder
on this desktop does not satisfy independent custody. The provider-held key is
protected by the account's authentication and access controls rather than a
second passphrase generated and retained only on this laptop.

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

Some object-store backends return a successful empty stream from `cat` for a
missing object. Before uploading in that case, the replicator independently checks
`lsjson --stat --files-only`: only a null result or an explicit missing-file error
counts as absence. An existing zero-byte object, malformed stat or permission
failure stops without upload. COMPLIANCE retention protects existing versions;
the uploader cannot shorten retention or delete them.

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
