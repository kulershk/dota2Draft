#!/bin/bash
# Database backup script for Dota 2 Draft
# Usage: ./backup.sh

BACKUP_DIR="$(dirname "$0")/backup"
TIMESTAMP=$(date +"%Y-%m-%d_%H-%M-%S")
FILENAME="draft_${TIMESTAMP}.sql.gz"

mkdir -p "$BACKUP_DIR"

echo "Creating backup: $FILENAME"
docker exec draft-db pg_dump -U draft draft | gzip > "$BACKUP_DIR/$FILENAME"

if [ $? -eq 0 ]; then
  echo "Backup saved to backup/$FILENAME"
  # Keep only last 30 backups
  ls -t "$BACKUP_DIR"/draft_*.sql.gz 2>/dev/null | tail -n +31 | xargs -r rm
  echo "Total backups: $(ls "$BACKUP_DIR"/draft_*.sql.gz 2>/dev/null | wc -l)"
else
  echo "Backup failed!"
  exit 1
fi
