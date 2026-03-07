#!/bin/bash
docker compose -f docker/prod/docker-compose.yml --env-file docker/prod/.env up -d --build
