#!/bin/bash
set -euo pipefail
umask 077
cd /opt/acquarella/deploy/vps
destination=/opt/acquarella/backups
install -d -m 700 "$destination"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
temporary=$(mktemp -d "$destination/.backup-XXXXXX")
trap 'echo "Backup incompleto preservado em $temporary" >&2' ERR
docker compose exec -T postgres pg_dump -U postgres -d acquarella --format=custom --schema=public > "$temporary/database.dump"
volume=$(docker volume inspect acquarella_whatsapp-data --format '{{.Mountpoint}}')
sqlite3 "$volume/whatsapp.sqlite" ".backup '$temporary/whatsapp.sqlite'"
tar -czf "$temporary/configuration.tar.gz" .env app.env gateway.env cashbarber.env compose.yaml Caddyfile
# The application owns encrypted session and operation files; stop new writes only
# for the short copy window, without touching the WhatsApp service.
cashvolume=$(docker volume inspect acquarella_cashbarber-data --format '{{.Mountpoint}}')
docker compose pause cashbarber >/dev/null
trap 'docker compose unpause cashbarber >/dev/null; echo "Backup incompleto preservado em $temporary" >&2' ERR
tar -czf "$temporary/cashbarber.tar.gz" -C "$cashvolume" .
docker compose unpause cashbarber >/dev/null
tar -czf "$destination/acquarella-$stamp.tar.gz" -C "$temporary" database.dump whatsapp.sqlite configuration.tar.gz cashbarber.tar.gz
# Keep the source files too until the resulting archive has been verified.
tar -tzf "$destination/acquarella-$stamp.tar.gz" >/dev/null
docker compose exec -T postgres pg_restore --list < "$temporary/database.dump" >/dev/null
test "$(sqlite3 "$temporary/whatsapp.sqlite" 'pragma quick_check;')" = ok
case "$temporary" in "$destination"/.backup-*) rm -rf -- "$temporary";; *) exit 1;; esac
find "$destination" -maxdepth 1 -type f -name 'acquarella-*.tar.gz' -mtime +14 -delete
echo "Backup criado: acquarella-$stamp.tar.gz"
