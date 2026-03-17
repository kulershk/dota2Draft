#!/bin/bash
if [ "$1" = "--pull" ] || [ "$1" = "-p" ]; then
  git pull
fi
docker compose --env-file docker/prod/.env -f docker/prod/docker-compose.yml build --no-cache draft-lobbybot
docker compose --env-file docker/prod/.env -f docker/prod/docker-compose.yml up -d --build
