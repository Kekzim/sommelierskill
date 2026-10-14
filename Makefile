BINARY := bolagetdb
DB     := bolaget.db

# Optional local overrides, gitignored: put machine-specific values here rather
# than in the file everyone else reads.
-include .makerc

.PHONY: build sync stores stats test fmt vet clean skill

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

# Skill package for the Claude apps (claude.ai / desktop). It carries method
# and judgement only: the data comes from the Systembolaget connector, so there
# is nothing in it to go stale and no mirror to build it from.
skill:
	rm -rf dist/sommelier
	mkdir -p dist/sommelier
	cp -r skill/. dist/sommelier/
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
	@echo "On the NAS: set IMAGE_TAG=$(VERSION) in .env, then ./run.sh"
	@echo "  (deploy/unraid/RUNBOOK.md; the NAS runs plain docker run, not Compose)"
