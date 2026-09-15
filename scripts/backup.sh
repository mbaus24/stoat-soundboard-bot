#!/bin/sh
# Daily backup of recorded sounds + registry.
# Usage: sh scripts/backup.sh [output.tar.gz]
# Cron (TrueNAS host): 0 2 * * * /home/truenas_admin/stoat-soundboard-bot/scripts/backup.sh >> /var/log/soundboard-backup.log 2>&1
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/backups"
mkdir -p "$DEST"
if [ -n "$1" ]; then
  case "$1" in
    /*) OUT="$1" ;;
    *) OUT="$ROOT/$1" ;;
  esac
  mkdir -p "$(dirname "$OUT")"
else
  TS="$(date +%Y%m%d-%H%M%S)"
  OUT="$DEST/sounds-$TS.tar.gz"
fi
tar -czf "$OUT" -C "$ROOT" sounds
# keep only the 14 newest backups
ls -1t "$DEST"/sounds-*.tar.gz 2>/dev/null | tail -n +15 | xargs -r rm --
echo "saved $OUT"
