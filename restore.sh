#!/bin/bash
# Database restore script for Dota 2 Draft
# Usage: ./restore.sh [backup_file]
#   ./restore.sh                          # lists available backups to choose from
#   ./restore.sh backup/draft_2026-04-01_12-00-00.sql.gz  # restore specific file

BACKUP_DIR="$(dirname "$0")/backup"

# If no argument, list backups and let user pick
if [ -z "$1" ]; then
  BACKUPS=($(ls -t "$BACKUP_DIR"/draft_*.sql.gz 2>/dev/null))
  if [ ${#BACKUPS[@]} -eq 0 ]; then
    echo "No backups found in $BACKUP_DIR"
    exit 1
  fi
  echo "Available backups:"
  for i in "${!BACKUPS[@]}"; do
    SIZE=$(du -h "${BACKUPS[$i]}" | cut -f1)
    echo "  [$i] $(basename "${BACKUPS[$i]}") ($SIZE)"
  done
  echo ""
  read -p "Enter number to restore (or 'q' to quit): " CHOICE
  if [ "$CHOICE" = "q" ]; then exit 0; fi
  if ! [[ "$CHOICE" =~ ^[0-9]+$ ]] || [ "$CHOICE" -ge ${#BACKUPS[@]} ]; then
    echo "Invalid selection"
    exit 1
  fi
  BACKUP_FILE="${BACKUPS[$CHOICE]}"
else
  BACKUP_FILE="$1"
fi

if [ ! -f "$BACKUP_FILE" ]; then
  echo "File not found: $BACKUP_FILE"
  exit 1
fi

echo ""
echo "WARNING: This will overwrite the current database!"
echo "Restoring from: $(basename "$BACKUP_FILE")"
read -p "Are you sure? (y/N): " CONFIRM
if [ "$CONFIRM" != "y" ] && [ "$CONFIRM" != "Y" ]; then
  echo "Cancelled."
  exit 0
fi

echo "Restoring..."
gunzip -c "$BACKUP_FILE" | docker exec -i draft-db psql -U draft -d draft --single-transaction

if [ $? -eq 0 ]; then
  echo "Restore complete!"
else
  echo "Restore failed!"
  exit 1
fi
