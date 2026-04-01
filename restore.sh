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

# Stop the app so it doesn't hold DB connections
echo "Stopping app container..."
docker stop draft-app 2>/dev/null || docker stop draft-dev-app 2>/dev/null || true

# Drop all tables/sequences/functions in the draft database
echo "Dropping all existing objects..."
docker exec draft-db psql -U draft -d draft -c "
  DO \$\$ DECLARE r RECORD;
  BEGIN
    FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname = 'public') LOOP
      EXECUTE 'DROP TABLE IF EXISTS public.' || quote_ident(r.tablename) || ' CASCADE';
    END LOOP;
    FOR r IN (SELECT sequence_name FROM information_schema.sequences WHERE sequence_schema = 'public') LOOP
      EXECUTE 'DROP SEQUENCE IF EXISTS public.' || quote_ident(r.sequence_name) || ' CASCADE';
    END LOOP;
  END \$\$;"

# Restore the backup
echo "Loading backup..."
gunzip -c "$BACKUP_FILE" | docker exec -i draft-db psql -U draft -d draft -v ON_ERROR_STOP=1

RESULT=$?

# Restart the app
echo "Starting app container..."
docker start draft-app 2>/dev/null || docker start draft-dev-app 2>/dev/null || true

if [ $RESULT -eq 0 ]; then
  echo "Restore complete!"
else
  echo "Restore failed! The database may be empty — re-run with a different backup or check errors above."
  exit 1
fi
