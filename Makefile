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
	./$(BINARY) export
	cd dist && rm -f sommelier.zip && zip -qr sommelier.zip sommelier
	@ls -lh dist/sommelier.zip | awk '{print "packaged:", $$5, $$9}'
