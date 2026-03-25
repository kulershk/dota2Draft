#!/bin/bash
if [ "$1" = "--pull" ] || [ "$1" = "-p" ]; then
  git pull
fi
if [ "$1" = "-lb" ]; then
docker compose --env-file docker/prod/.env -f docker/prod/docker-compose.yml build --no-cache draft-lobbybot
fi
docker compose --env-file docker/prod/.env -f docker/prod/docker-compose.yml up -d --build
