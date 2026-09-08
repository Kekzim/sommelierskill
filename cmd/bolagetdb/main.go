// Command bolagetdb builds and queries a local mirror of Systembolaget's
// assortment.
//
// The upstream API is a product search, not a query engine: free text is
// single-term, there is no aggregation, no boolean logic and no derived
// sorting. Mirroring the ~27k products locally costs about eight minutes and
// ~20MB and turns all of that into SQL.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"text/tabwriter"
	"time"

	"github.com/Kekzim/sommelierskill/internal/fetch"
	"github.com/Kekzim/sommelierskill/internal/normalize"
	"github.com/Kekzim/sommelierskill/internal/store"
	"github.com/alexgustafsson/systembolaget-api/v5/systembolaget"
	"github.com/urfave/cli/v3"
)

func main() {
	root := &cli.Command{
		Name:  "bolagetdb",
		Usage: "Local mirror of Systembolaget's assortment, queryable with SQL",
		Flags: []cli.Flag{
			&cli.StringFlag{
				Name:    "db",
				Usage:   "Path to the SQLite database. Defaults to ./bolaget.db if present, else the user data dir",
				Sources: cli.EnvVars("BOLAGETDB"),
			},
			&cli.BoolFlag{Name: "verbose", Usage: "Enable debug logs"},
		},
		Commands: []*cli.Command{
			{
				Name:   "sync",
				Usage:  "Pull the full assortment into the database",
				Action: actionSync,
				Flags: []cli.Flag{
					&cli.StringFlag{Name: "api-key", Usage: "API key. Defaults to fetching one"},
					&cli.DurationFlag{
						Name:  "page-delay",
						Usage: "Delay between pages, to stay polite to an undocumented API",
						Value: 100 * time.Millisecond,
					},
					&cli.StringFlag{
						Name:  "snapshot-dir",
						Usage: "Write a dated JSONL snapshot here. History cannot be reconstructed later",
						Value: "snapshots",
					},
					&cli.BoolFlag{Name: "no-snapshot", Usage: "Skip writing the JSONL snapshot"},
					&cli.BoolFlag{Name: "no-enrich", Usage: "Skip the otherSelections enrichment passes"},
					&cli.StringFlag{
						Name:  "only",
						Usage: "Only sync slices whose name contains this (case-insensitive). For debugging",
					},
					&cli.BoolFlag{
						Name:  "no-prune",
						Usage: "Keep products that were not seen this run, instead of removing delisted ones",
					},
					&cli.BoolFlag{
						Name:  "skip-products",
						Usage: "Skip the product fetch and only re-run enrichment and store passes against the existing database",
					},
					&cli.StringSliceFlag{
						Name:  "store",
						Usage: "Also mirror this store's assortment (repeatable). Find ids with `bolagetdb stores`",
					},
				},
			},
			{
				Name:   "stores",
				Usage:  "Sync the store list, or search it",
				Action: actionStores,
				Flags: []cli.Flag{
					&cli.StringFlag{Name: "api-key"},
					&cli.StringFlag{Name: "search", Aliases: []string{"q"}, Usage: "Search instead of syncing"},
				},
			},
			{
				Name:      "query",
				Usage:     "Run SQL against the database",
				ArgsUsage: "<sql>",
				Action:    actionQuery,
				Flags: []cli.Flag{
					&cli.StringFlag{
						Name:  "format",
						Usage: "Output format: table, json or csv",
						Value: "table",
					},
					&cli.IntFlag{Name: "limit", Usage: "Truncate output after N rows (0 = all)", Value: 0},
				},
			},
			{
				Name:   "export",
				Usage:  "Write a portable slim snapshot for bundling with a skill",
				Action: actionExport,
				Flags: []cli.Flag{
					&cli.StringFlag{
						Name:  "output",
						Usage: "Destination file",
						Value: "dist/sommelier/data/bolaget-slim.db",
					},
					&cli.IntFlag{
						Name:  "max-availability-rank",
						Usage: "1 = shelf-stocked only, 2 = also limited, 3 = everything including order-only",
						Value: 2,
					},
				},
			},
			{
				Name:   "stats",
				Usage:  "Summarise what is in the database and how fresh it is",
				Action: actionStats,
			},
		},
	}

	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	if err := root.Run(ctx, os.Args); err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

// dbPath resolves where the database lives, in order:
//
//	--db or $BOLAGETDB, then ./bolaget.db if it exists, then the user data dir.
//
// Resolving here rather than hardcoding a path means the skill can just say
// "run bolagetdb query" and work on any machine.
func dbPath(cmd *cli.Command) string {
	if p := cmd.String("db"); p != "" {
		return p
	}
	if _, err := os.Stat("bolaget.db"); err == nil {
		return "bolaget.db"
	}
	dir := os.Getenv("XDG_DATA_HOME")
	if dir == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return "bolaget.db"
		}
		dir = filepath.Join(home, ".local", "share")
	}
	return filepath.Join(dir, "bolagetdb", "bolaget.db")
}

func logger(cmd *cli.Command) *slog.Logger {
	level := slog.LevelInfo
	if cmd.Bool("verbose") {
		level = slog.LevelDebug
	}
	return slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: level}))
}

func client(ctx context.Context, cmd *cli.Command) (*systembolaget.AuthenticatedClient, error) {
	// Retry in the transport rather than at the call sites, so every request
	// the upstream library makes is covered -- including the API-key fetch
	// below, which is a single point of failure for the whole run.
	httpClient := fetch.RetryingClient(systembolaget.DefaultClient.Client, logger(cmd))
	if key := cmd.String("api-key"); key != "" {
		return &systembolaget.AuthenticatedClient{APIKey: key, Client: httpClient}, nil
	}
	c, err := (&systembolaget.Client{Client: httpClient}).GetAuthenticatedClient(ctx)
	if err != nil {
		return nil, fmt.Errorf("could not obtain an API key (pass --api-key to override): %w", err)
	}
	return c, nil
}

func actionSync(ctx context.Context, cmd *cli.Command) error {
	log := logger(cmd)
	started := time.Now()

	c, err := client(ctx, cmd)
	if err != nil {
		return err
	}
	path := dbPath(cmd)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	db, err := store.Open(path)
	if err != nil {
		return err
	}
	defer db.Close()

	f := &fetch.Fetcher{Client: c, PageDelay: cmd.Duration("page-delay"), Log: log}

	// Snapshot first: history cannot be reconstructed after the fact, and it is
	// the only artifact that survives a schema change.
	var snapshot *os.File
	snapshotPath := ""
	if !cmd.Bool("no-snapshot") && !cmd.Bool("skip-products") {
		dir := cmd.String("snapshot-dir")
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return err
		}
		snapshotPath = filepath.Join(dir, started.UTC().Format("2006-01-02")+".jsonl")
		if snapshot, err = os.Create(snapshotPath); err != nil {
			return err
		}
		defer snapshot.Close()
	}

	skipProducts := cmd.Bool("skip-products")

	var slices []fetch.Slice
	if !skipProducts {
		log.Info("planning slices")
		if slices, err = f.PlanSlices(ctx); err != nil {
			return err
		}
	} else {
		log.Warn("skipping the product fetch; only enrichment and store passes will run")
	}
	if only := cmd.String("only"); only != "" {
		var kept []fetch.Slice
		for _, s := range slices {
			if strings.Contains(strings.ToLower(s.String()), strings.ToLower(only)) {
				kept = append(kept, s)
			}
		}
		if len(kept) == 0 {
			return fmt.Errorf("no slice matches %q", only)
		}
		slices = kept
		log.Warn("syncing a subset only", slog.String("filter", only), slog.Int("slices", len(slices)))
	}

	total := 0
	for _, s := range slices {
		total += s.Est
	}
	log.Info("plan ready", slog.Int("slices", len(slices)), slog.Int("expectedProducts", total))

	runID, err := db.StartRun(started, snapshotPath)
	if err != nil {
		return err
	}

	fetched, failures, incomplete := 0, 0, 0
	if !skipProducts {
		fetched, failures, incomplete, err = syncProducts(ctx, log, f, db, slices, started, snapshot)
		if err != nil {
			return err
		}
	}

	// otherSelections is filterable upstream but absent from product records,
	// so these flags exist nowhere except here.
	if !cmd.Bool("no-enrich") {
		for value, column := range fetch.OtherSelections {
			ids, err := f.EnrichOtherSelections(ctx, value)
			if err != nil {
				failures++
				log.Error("enrichment failed", slog.String("attribute", value), slog.Any("error", err))
				continue
			}
			if err := db.SetFlag(column, ids); err != nil {
				return err
			}
			log.Info("enriched", slog.String("attribute", value), slog.Int("products", len(ids)))
		}
	}

	for _, siteID := range cmd.StringSlice("store") {
		ids, err := f.StoreAssortment(ctx, siteID)
		if err != nil {
			failures++
			log.Error("store assortment failed", slog.String("store", siteID), slog.Any("error", err))
			continue
		}
		if err := db.SetStoreAssortment(siteID, ids, started); err != nil {
			return err
		}
		log.Info("store assortment stored", slog.String("store", siteID), slog.Int("products", len(ids)))
	}

	// Only a run that fetched every slice cleanly is evidence that a missing
	// product is genuinely delisted rather than merely unfetched.
	fullRun := !skipProducts && cmd.String("only") == "" && failures == 0 && incomplete == 0
	switch {
	case cmd.Bool("no-prune") || !fullRun:
		if !cmd.Bool("no-prune") && !skipProducts {
			log.Warn("skipping prune; this run was not complete",
				slog.Int("failures", failures), slog.Int("incompleteSlices", incomplete))
		}
	default:
		pruned, err := db.PruneStale(ctx, started)
		if err != nil {
			return err
		}
		if pruned > 0 {
			log.Info("pruned delisted products", slog.Int("count", pruned))
		}
	}

	if err := db.Optimize(); err != nil {
		log.Warn("optimize failed", slog.Any("error", err))
	}
	note := ""
	if incomplete > 0 {
		note = fmt.Sprintf("%d slices incompletely covered", incomplete)
	}
	if err := db.FinishRun(runID, fetched, len(slices), failures, note); err != nil {
		return err
	}

	log.Info("sync complete",
		slog.Int("products", fetched), slog.Int("slices", len(slices)),
		slog.Int("errors", failures), slog.Duration("took", time.Since(started)))
	if failures > 0 {
		return fmt.Errorf("sync finished with %d failures", failures)
	}
	return nil
}

func actionStores(ctx context.Context, cmd *cli.Command) error {
	log := logger(cmd)
	c, err := client(ctx, cmd)
	if err != nil {
		return err
	}

	if q := cmd.String("search"); q != "" {
		stores, err := c.SearchStores(ctx, q, false)
		if err != nil {
			return err
		}
		tw := tabwriter.NewWriter(os.Stdout, 0, 4, 2, ' ', 0)
		fmt.Fprintln(tw, "SITE ID\tNAME\tCITY\tCOUNTY")
		for _, s := range stores {
			fmt.Fprintf(tw, "%s\t%s\t%s\t%s\n", s.SiteID, s.DisplayName, s.City, s.County)
		}
		return tw.Flush()
	}

	db, err := store.Open(dbPath(cmd))
	if err != nil {
		return err
	}
	defer db.Close()

	stores, err := c.GetStores(ctx)
	if err != nil {
		return err
	}
	n, err := db.PutStores(stores, time.Now())
	if err != nil {
		return err
	}
	log.Info("stores stored", slog.Int("count", n))
	return nil
}

func actionQuery(ctx context.Context, cmd *cli.Command) error {
	sql := strings.TrimSpace(strings.Join(cmd.Args().Slice(), " "))
	if sql == "" {
		return fmt.Errorf("no SQL given")
	}
	db, err := store.OpenExisting(dbPath(cmd))
	if err != nil {
		return err
	}
	defer db.Close()

	rows, err := db.SQL().QueryContext(ctx, sql)
	if err != nil {
		return err
	}
	defer rows.Close()

	cols, err := rows.Columns()
	if err != nil {
		return err
	}

	limit := cmd.Int("limit")
	format := cmd.String("format")
	var tw *tabwriter.Writer
	if format == "table" {
		tw = tabwriter.NewWriter(os.Stdout, 0, 4, 2, ' ', 0)
		fmt.Fprintln(tw, strings.Join(upper(cols), "\t"))
	}
	enc := json.NewEncoder(os.Stdout)

	n := 0
	for rows.Next() {
		vals := make([]any, len(cols))
		ptrs := make([]any, len(cols))
		for i := range vals {
			ptrs[i] = &vals[i]
		}
		if err := rows.Scan(ptrs...); err != nil {
			return err
		}

		switch format {
		case "json":
			m := make(map[string]any, len(cols))
			for i, c := range cols {
				m[c] = coerce(vals[i])
			}
			if err := enc.Encode(m); err != nil {
				return err
			}
		case "csv":
			fmt.Println(strings.Join(mapStr(vals, csvCell), ","))
		default:
			fmt.Fprintln(tw, strings.Join(mapStr(vals, cell), "\t"))
		}

		n++
		if limit > 0 && n >= limit {
			break
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	if tw != nil {
		return tw.Flush()
	}
	return nil
}

func actionStats(ctx context.Context, cmd *cli.Command) error {
	db, err := store.OpenExisting(dbPath(cmd))
	if err != nil {
		return err
	}
	defer db.Close()
	return db.Stats(ctx, os.Stdout)
}

// --- output helpers ----------------------------------------------------------

func upper(ss []string) []string {
	out := make([]string, len(ss))
	for i, s := range ss {
		out[i] = strings.ToUpper(s)
	}
	return out
}

func mapStr(vals []any, f func(any) string) []string {
	out := make([]string, len(vals))
	for i, v := range vals {
		out[i] = f(v)
	}
	return out
}

// coerce turns driver values into something that survives JSON encoding.
// The sqlite driver hands back []byte for TEXT, which would otherwise be
// base64-encoded into the output.
func coerce(v any) any {
	if b, ok := v.([]byte); ok {
		return string(b)
	}
	return v
}

func cell(v any) string {
	switch x := coerce(v).(type) {
	case nil:
		return ""
	case string:
		return x
	case float64:
		// Print whole numbers without a trailing .0
		if x == float64(int64(x)) {
			return fmt.Sprintf("%d", int64(x))
		}
		return fmt.Sprintf("%g", x)
	default:
		return fmt.Sprint(x)
	}
}

func csvCell(v any) string {
	s := cell(v)
	if strings.ContainsAny(s, `,"`+"\n") {
		return `"` + strings.ReplaceAll(s, `"`, `""`) + `"`
	}
	return s
}

// syncProducts fetches every slice into the database in one transaction.
func syncProducts(
	ctx context.Context,
	log *slog.Logger,
	f *fetch.Fetcher,
	db *store.DB,
	slices []fetch.Slice,
	started time.Time,
	snapshot *os.File,
) (fetched, failures, incomplete int, err error) {
	w, err := db.NewWriter()
	if err != nil {
		return 0, 0, 0, err
	}
	defer w.Rollback()

	// Shared across slices so a product is stored at most once per sync, and so
	// repeated passes over an unstable pagination order stay cheap.
	seen := make(map[string]struct{}, 32000)

	for i, s := range slices {
		res, err := f.FetchSlice(ctx, s, started, seen, func(p normalize.Product) error {
			if snapshot != nil {
				if _, err := snapshot.WriteString(p.Raw + "\n"); err != nil {
					return err
				}
			}
			return w.Put(p)
		})
		fetched += res.Unique
		if err != nil {
			// One bad slice should not cost the whole run.
			failures++
			log.Error("slice failed", slog.String("slice", s.String()), slog.Any("error", err))
			if ctx.Err() != nil {
				break
			}
			continue
		}
		if !res.Complete {
			incomplete++
		}
		log.Info("slice done",
			slog.String("slice", s.String()),
			slog.Int("unique", res.Unique), slog.Int("expected", s.Est),
			slog.Int("rows", res.Rows), slog.Int("passes", res.Passes),
			slog.Bool("complete", res.Complete),
			slog.String("progress", fmt.Sprintf("%d/%d", i+1, len(slices))))
	}
	if incomplete > 0 {
		log.Warn("some slices could not be fully covered", slog.Int("slices", incomplete))
	}

	if err := w.Commit(); err != nil {
		return fetched, failures, incomplete, fmt.Errorf("committing products: %w", err)
	}
	log.Info("products stored", slog.Int("count", fetched), slog.Int("failedSlices", failures))
	return fetched, failures, incomplete, nil
}

func actionExport(ctx context.Context, cmd *cli.Command) error {
	log := logger(cmd)
	db, err := store.OpenExisting(dbPath(cmd))
	if err != nil {
		return err
	}
	defer db.Close()

	out := cmd.String("output")
	if err := os.MkdirAll(filepath.Dir(out), 0o755); err != nil {
		return err
	}

	n, err := db.ExportSlim(ctx, out, cmd.Int("max-availability-rank"))
	if err != nil {
		return err
	}

	info, err := os.Stat(out)
	if err != nil {
		return err
	}
	log.Info("snapshot exported",
		slog.String("path", out), slog.Int("products", n),
		slog.String("size", fmt.Sprintf("%.1f MB", float64(info.Size())/(1<<20))))
	return nil
}
