BINARY := bolagetdb
DB     := bolaget.db

.PHONY: build sync stores stats test fmt vet clean

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

# Portable skill package for the Claude apps (claude.ai / desktop).
# The local .claude/skills/sommelier skill targets Claude Code and drives the
# full database; this one bundles a slim snapshot and runs anywhere.
skill: build
	rm -rf dist/sommelier
	mkdir -p dist/sommelier
	cp -r skill/. dist/sommelier/
	./$(BINARY) export --output dist/sommelier/data/bolaget-slim.db
	cd dist && rm -f sommelier.zip && zip -qr sommelier.zip sommelier
	@echo "--- package ---" && find dist/sommelier -type f | sort
	@ls -lh dist/sommelier.zip | awk '{print "packaged:", $$5, $$9}'

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
	@echo "On the NAS: set IMAGE_TAG=$(VERSION) in .env, then"
	@echo "  docker compose pull && docker compose up -d"
