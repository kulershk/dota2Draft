# Dota 2 Auction Draft

Salary cap auction draft system for Dota 2 amateur leagues.

## Docker Commands

### Development

```bash
# Start dev environment (frontend + backend + postgres)
docker compose -f docker/dev/docker-compose.yml up -d --build

# Stop dev environment
docker compose -f docker/dev/docker-compose.yml down

# View logs
docker compose -f docker/dev/docker-compose.yml logs -f

# View only app logs
docker logs -f draft-dev-app

# Rebuild after dependency changes
docker compose -f docker/dev/docker-compose.yml up -d --build

# Run tests inside container
docker exec draft-dev-app npm test

# Run import script
docker exec draft-dev-app node server/scripts/import-spreadsheet.js

# Access dev database
docker exec -it draft-dev-db psql -U draft draft
```

### Production

```bash
# Start production (with Traefik reverse proxy)
docker compose -f docker/prod/docker-compose.yml up -d --build

# Stop production
docker compose -f docker/prod/docker-compose.yml down

# View logs
docker compose -f docker/prod/docker-compose.yml logs -f
docker logs -f draft

# Rebuild and restart (zero downtime)
docker compose -f docker/prod/docker-compose.yml up -d --build

# Run import script
docker exec draft node server/scripts/import-spreadsheet.js

# Access production database
docker exec -it draft-db psql -U draft draft
```

### Database

```bash
# Backup database
bash backup.sh

# Restore from backup
gunzip -c backup/draft_2025-03-15_12-00-00.sql.gz | docker exec -i draft-db psql -U draft draft

# Full database reset (WARNING: deletes all data)
docker compose -f docker/prod/docker-compose.yml down -v
docker compose -f docker/prod/docker-compose.yml up -d

# Export database to file
docker exec draft-db pg_dump -U draft draft > dump.sql

# Import database from file
docker exec -i draft-db psql -U draft draft < dump.sql
```

### Maintenance

```bash
# Check running containers
docker ps

# Restart app only (keeps database running)
docker restart draft

# Shell into app container
docker exec -it draft sh

# Shell into database container
docker exec -it draft-db sh

# View disk usage
docker system df

# Clean unused images/containers
docker system prune -f

# View database volume size
docker volume inspect draft_pgdata
```

## Environment Variables

Create `.env` in the docker compose directory:

```
STEAM_API_KEY=your_steam_api_key
JWT_SECRET=your_jwt_secret
TWITCH_CLIENT_ID=your_twitch_client_id
TWITCH_CLIENT_SECRET=your_twitch_client_secret
DISCORD_CLIENT_ID=your_discord_client_id
DISCORD_CLIENT_SECRET=your_discord_client_secret
```

## Local Development (without Docker)

```bash
npm install
npm run dev          # starts frontend + backend
npm test             # run tests
npm run build        # build for production
```

Requires PostgreSQL running locally on port 5432 (user: draft, db: draft).
