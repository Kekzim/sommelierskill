BINARY := bolagetdb
DB     := bolaget.db

# Optional local overrides, gitignored: put machine-specific values here rather
# than in the file everyone else reads. `NAS_DB = root@your-nas:/path/bolaget.db`
# is the one this repo expects.
-include .makerc

.PHONY: build sync stores stats test fmt vet clean skill skill-nas snapshot-age

build:
	go build -o $(BINARY) ./cmd/bolagetdb

# Full assortment pull. ~25 minutes, polite by default.
sync: build
	./$(BINARY) --verbose sync

stores: build
	./$(BINARY) stores

stats: build
	./$(BINARY) stats

test:
	go test ./...

fmt:
	gofmt -w .

vet:
	go vet ./...

clean:
	rm -f $(BINARY) $(DB) $(DB)-wal $(DB)-shm

# Which mirror the snapshot is exported from. Empty means bolagetdb's own
# resolution (~/.local/share/bolagetdb/bolaget.db) -- this workstation's mirror,
# which is only as fresh as the last sync run *here*. The NAS holds the one that
# is actually kept current; see skill-nas below.
SKILL_DB ?=
SKILL_DB_FLAG = $(if $(SKILL_DB),--db $(SKILL_DB),)
# scp target for the NAS mirror. Override on the command line, or edit this.
NAS_DB ?= root@YOUR-NAS:/mnt/user/appdata/sommelier/bolaget.db

# Portable skill package for the Claude apps (claude.ai / desktop).
# The local .claude/skills/sommelier skill targets Claude Code and drives the
# full database; this one bundles a slim snapshot and runs anywhere.
skill: build
	rm -rf dist/sommelier
	mkdir -p dist/sommelier
	cp -r skill/. dist/sommelier/
	./$(BINARY) $(SKILL_DB_FLAG) export --output dist/sommelier/data/bolaget-slim.db
	cd dist && rm -f sommelier.zip && zip -qr sommelier.zip sommelier
	@echo "--- package ---" && find dist/sommelier -type f | sort
	@ls -lh dist/sommelier.zip | awk '{print "packaged:", $$5, $$9}'
	@$(MAKE) --no-print-directory snapshot-age

# The snapshot's age is the one thing about this package that fails silently:
# a stale bundle looks identical to a fresh one and simply gives wrong prices
# and misses new releases. So say it out loud after every build.
snapshot-age:
	@src=$$(./$(BINARY) --db dist/sommelier/data/bolaget-slim.db query --format csv \
	          "SELECT value FROM meta WHERE key='source_sync'" 2>/dev/null | tail -1); \
	if [ -z "$$src" ]; then echo "snapshot: could not read source_sync"; exit 0; fi; \
	days=$$(( ( $$(date +%s) - $$(date -d "$$src" +%s) ) / 86400 )); \
	echo "snapshot data: $$src ($$days days old)"; \
	if [ $$days -gt 10 ]; then \
	  echo "WARNING: older than a weekly sync cycle."; \
	  echo "  This workstation's mirror is not the one being refreshed -- the NAS is."; \
	  echo "  Use 'make skill-nas' to build from the mirror that is actually current."; \
	fi

# Build the package from the NAS mirror, which the sync container refreshes
# weekly. Asks for the NAS password: there is no key installed, deliberately.
skill-nas:
	@case "$(NAS_DB)" in *YOUR-NAS*) \
	  echo "set NAS_DB to your server, e.g. make skill-nas NAS_DB=root@nas:/mnt/user/appdata/sommelier/bolaget.db"; \
	  exit 1;; esac
	@mkdir -p dist
	@echo "copying the NAS mirror (~120 MB) -- this will ask for the NAS password"
	scp $(NAS_DB) dist/nas-mirror.db
	@$(MAKE) --no-print-directory skill SKILL_DB=dist/nas-mirror.db
	rm -f dist/nas-mirror.db

# Install the binary so the Claude Code skill can call it from any directory.
install: build
	install -Dm755 $(BINARY) $(HOME)/.local/bin/$(BINARY)
	@echo "installed -> $(HOME)/.local/bin/$(BINARY)"

# --- release -----------------------------------------------------------------
#
# Builds both images, stamps them with VERSION, and pushes VERSION and latest.
# The NAS pins IMAGE_TAG to VERSION in its .env, so a deploy is a decision
# rather than whatever happened to be pushed last.
#
#   docker login ghcr.io -u Kekzim      # a token with write:packages
#   make release VERSION=v1.0.0
#
# MCP_AUTH_TOKEN only satisfies interpolation during the build; nothing is baked
# into an image.
SYNC_IMAGE := ghcr.io/kekzim/bolagetdb-sync
MCP_IMAGE  := ghcr.io/kekzim/systembolaget-mcp-server

.PHONY: release
release:
	@test -n "$(VERSION)" || { echo "usage: make release VERSION=v1.0.0"; exit 1; }
	@case "$(VERSION)" in latest) echo "VERSION must name a release, not latest"; exit 1;; esac
	@test -z "$$(git status --porcelain)" || \
	  echo "WARNING: working tree is dirty; this image will not match any commit"
	IMAGE_TAG=$(VERSION) MCP_AUTH_TOKEN=build docker compose build
	IMAGE_TAG=$(VERSION) MCP_AUTH_TOKEN=build docker compose push
	docker tag $(SYNC_IMAGE):$(VERSION) $(SYNC_IMAGE):latest
	docker tag $(MCP_IMAGE):$(VERSION)  $(MCP_IMAGE):latest
	docker push $(SYNC_IMAGE):latest
	docker push $(MCP_IMAGE):latest
	@echo
	@echo "pushed $(VERSION) and latest."
	@echo "On the NAS: set IMAGE_TAG=$(VERSION) in .env, then ./run.sh"
	@echo "  (deploy/unraid/RUNBOOK.md; the NAS runs plain docker run, not Compose)"
