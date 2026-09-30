#!/bin/bash
set -euo pipefail
umask 077
exec 9>/opt/zoko/backups/automatic.lock
flock -n 9 || exit 0
root=/opt/zoko
stamp=$(date -u +%Y%m%dT%H%M%SZ)
tmp=$(mktemp -d "$root/backups/.encrypt.XXXXXXXX")
trap 'rm -f -- "$tmp/database.dump" "$tmp/database.dump.sha256" "$tmp/database.dump.age"; rmdir -- "$tmp"' EXIT
export COMPOSE_FILE="$root/current/compose.yaml:$root/current/compose.hetzner.yaml"
/usr/bin/node "$root/current/scripts/backup.mjs" "$tmp/database.dump" >/dev/null
/usr/local/bin/zoko-age -R "$root/secrets/recovery-recipient.txt" -o "$tmp/database.dump.age" "$tmp/database.dump"
destination="$root/backups/encrypted/zoko-$stamp.dump.age"
test ! -e "$destination"
mv -- "$tmp/database.dump.age" "$destination"
python3 - "$destination" "$tmp/database.dump" <<'PY'
import datetime,hashlib,json,os,pathlib,sys
encrypted=pathlib.Path(sys.argv[1]);plain=pathlib.Path(sys.argv[2])
result={'completedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'encryptedBackup':str(encrypted),'encryptedBytes':encrypted.stat().st_size,'encryptedSha256':hashlib.sha256(encrypted.read_bytes()).hexdigest(),'plaintextBytes':plain.stat().st_size,'plaintextSha256':hashlib.sha256(plain.read_bytes()).hexdigest(),'identityPresentOnServer':False,'decryptionVerifiedOnServer':False}
# Immutable per-snapshot metadata lets replication recover an upload backlog.
sidecar=encrypted.with_suffix(encrypted.suffix+'.json')
with sidecar.open('x') as f:
    f.write(json.dumps(result,indent=2)+'\n');f.flush();os.fsync(f.fileno())
target=pathlib.Path('/opt/zoko/backups/encrypted/latest.json');temp=target.with_suffix('.tmp')
temp.write_text(json.dumps(result,indent=2)+'\n');os.replace(temp,target)
print(json.dumps(result))
PY
# Grant only the dedicated replicator group read access to ciphertext/metadata.
# No configuration, wallet secret, Docker socket or private identity is shared.
if getent group zoko-backup >/dev/null; then
  chgrp zoko-backup "$destination" "$destination.json"
  chmod 0640 "$destination" "$destination.json"
fi
# Only recognized encrypted backup files in this exact directory are eligible.
find "$root/backups/encrypted" -maxdepth 1 -type f -name 'zoko-????????T??????Z.dump.age' -mtime +30 -delete
find "$root/backups/encrypted" -maxdepth 1 -type f -name 'zoko-????????T??????Z.dump.age.json' -mtime +30 -delete
