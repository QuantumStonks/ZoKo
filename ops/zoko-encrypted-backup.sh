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
target=pathlib.Path('/opt/zoko/backups/encrypted/latest.json');temp=target.with_suffix('.tmp')
temp.write_text(json.dumps(result,indent=2)+'\n');os.replace(temp,target)
print(json.dumps(result))
PY
# Only recognized encrypted backup files in this exact directory are eligible.
find "$root/backups/encrypted" -maxdepth 1 -type f -name 'zoko-????????T??????Z.dump.age' -mtime +30 -delete
