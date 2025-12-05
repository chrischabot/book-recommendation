.PHONY: help setup dev build start test clean \
        db-up db-down db-migrate db-shell \
        download download-minimal download-full ingest enrich import features refresh

# Default target
help:
	@echo "Book Recommender - Available commands:"
	@echo ""
	@echo "Setup & Development:"
	@echo "  make setup      - Install dependencies and set up environment"
	@echo "  make dev        - Start development server"
	@echo "  make build      - Build for production"
	@echo "  make start      - Start production server"
	@echo "  make test       - Run tests"
	@echo ""
	@echo "Database:"
	@echo "  make db-up      - Start PostgreSQL (with AGE + pgvector)"
	@echo "  make db-down    - Stop PostgreSQL"
	@echo "  make db-migrate - Run database migrations"
	@echo "  make db-shell   - Open psql shell"
	@echo ""
	@echo "Data Pipeline:"
	@echo "  make download          - Download Open Library dumps (default, ~12.7GB)"
	@echo "  make download-minimal  - Download minimal set (~3.4GB)"
	@echo "  make download-full     - Download everything (~14GB)"
	@echo "  make ingest            - Ingest Open Library data"
	@echo "  make enrich     - Enrich with Google Books data"
	@echo "  make import     - Import user reading history"
	@echo "  make features   - Build embeddings and features"
	@echo "  make refresh    - Refresh all features"
	@echo ""
	@echo "Utilities:"
	@echo "  make clean      - Clean build artifacts"

# Setup
setup:
	pnpm install
	cp -n .env.example .env || true
	@echo "Setup complete! Edit .env with your API keys."

# Development
dev:
	pnpm dev

build:
	pnpm build

start:
	pnpm start

test:
	pnpm test

# Database
db-up:
	docker compose -f docker/docker-compose.yml up -d postgres
	@echo "Waiting for PostgreSQL to be ready..."
	@sleep 5
	@echo "PostgreSQL is ready!"

db-down:
	docker compose -f docker/docker-compose.yml down

db-migrate:
	pnpm migrate

db-shell:
	docker compose -f docker/docker-compose.yml exec postgres psql -U books -d books

# With Redis
db-up-full:
	docker compose -f docker/docker-compose.yml --profile cache up -d

# Data Pipeline
download:
	@echo "Downloading all Open Library dumps..."
	@echo "Includes everything (~14GB compressed)"
	pnpm download:ol -- --dir $(OPENLIBRARY_DUMPS_DIR)

download-minimal:
	@echo "Downloading minimal Open Library dumps..."
	@echo "Includes: works, authors (~3.4GB compressed)"
	pnpm download:ol -- --dir $(OPENLIBRARY_DUMPS_DIR) --preset minimal

download-core:
	@echo "Downloading core Open Library dumps..."
	@echo "Includes: works, editions, authors, ratings, reading-log (~12.7GB compressed)"
	pnpm download:ol -- --dir $(OPENLIBRARY_DUMPS_DIR) --preset default

ingest:
	pnpm ingest:ol -- --dir $(OPENLIBRARY_DUMPS_DIR) --tables works,editions,authors,ratings

enrich:
	pnpm enrich:gb -- --max 20000

import: import-goodreads

import-goodreads:
	pnpm import:goodreads -- --user $(USER_ID) --csv $(GOODREADS_EXPORT_CSV)

import-kindle:
	pnpm import:kindle -- --user $(USER_ID) --dir $(KINDLE_EXPORT_DIR)

features:
	pnpm features:embed -- --max 10000
	pnpm profile:build -- --user $(USER_ID)
	pnpm graph:build -- --user $(USER_ID)

refresh:
	pnpm refresh:all -- --user $(USER_ID)

# Utilities
clean:
	rm -rf .next
	rm -rf node_modules/.cache
	rm -rf data/cache

# Default variables
USER_ID ?= me
OPENLIBRARY_DUMPS_DIR ?= ./data/openlibrary
GOODREADS_EXPORT_CSV ?= ./data/goodreads/export.csv
KINDLE_EXPORT_DIR ?= ./data/kindle
