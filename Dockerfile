# The sync job: pulls Systembolaget's assortment into the mirror, then publishes
# a read-only-safe copy for the MCP server. Go, so no cgo and no sqlite3.
FROM golang:1.26-alpine AS build
WORKDIR /src
# Dependencies first, so source edits do not invalidate the module cache.
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY cmd/ ./cmd/
COPY internal/ ./internal/
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/bolagetdb ./cmd/bolagetdb

# Alpine rather than scratch: the schedule needs a shell and crond, and the
# publish step needs mv.
FROM alpine:3.21 AS runtime
RUN apk add --no-cache ca-certificates tzdata \
 && addgroup -g 10001 -S bolaget \
 && adduser -u 10001 -S bolaget -G bolaget \
 && mkdir -p /data \
 && chown bolaget:bolaget /data
COPY --from=build /out/bolagetdb /usr/local/bin/bolagetdb
COPY deploy/sync.sh /usr/local/bin/sync.sh
RUN chmod +x /usr/local/bin/sync.sh
USER 10001
VOLUME ["/data"]
ENV BOLAGETDB=/data/bolaget.db \
    TZ=Europe/Stockholm
ENTRYPOINT ["/usr/local/bin/sync.sh"]
CMD ["schedule"]
