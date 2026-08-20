#!/usr/bin/env python3
"""Query the bundled Systembolaget snapshot.

Standard library only. Usage:

    python3 scripts/query.py "SELECT full_name, price FROM product LIMIT 5"
    python3 scripts/query.py --format json "SELECT ..."
    python3 scripts/query.py --schema
"""

import argparse
import json
import os
import sqlite3
import sys

DB = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data", "bolaget-slim.db")


def connect():
    if not os.path.exists(DB):
        sys.exit(f"snapshot not found at {DB}")
    con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    return con


def show_schema(con):
    for (sql,) in con.execute(
        "SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' "
        "AND name NOT LIKE 'product_fts_%' ORDER BY type DESC, name"
    ):
        print(sql, ";\n", sep="")
    meta = dict(con.execute("SELECT key, value FROM meta").fetchall())
    print("-- snapshot:", json.dumps(meta))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("sql", nargs="?")
    ap.add_argument("--format", choices=["table", "json", "csv"], default="table")
    ap.add_argument("--limit", type=int, default=50,
                    help="max rows printed (0 = all); the query itself is unchanged")
    ap.add_argument("--schema", action="store_true")
    args = ap.parse_args()

    con = connect()
    if args.schema:
        show_schema(con)
        return
    if not args.sql:
        ap.error("provide SQL, or --schema")

    try:
        cur = con.execute(args.sql)
    except sqlite3.OperationalError as e:
        if "no such module: fts5" in str(e).lower():
            sys.exit("This Python build lacks FTS5. Use LIKE instead, e.g.\n"
                     "  WHERE taste LIKE '%tobak%' AND taste LIKE '%körsbär%' "
                     "AND taste NOT LIKE '%ek%'")
        sys.exit(f"SQL error: {e}")

    rows = cur.fetchall()
    if not rows:
        print("(no rows)")
        return
    if args.limit:
        rows = rows[: args.limit]
    cols = rows[0].keys()

    if args.format == "json":
        for r in rows:
            print(json.dumps(dict(r), ensure_ascii=False))
    elif args.format == "csv":
        print(",".join(cols))
        for r in rows:
            print(",".join("" if v is None else str(v) for v in r))
    else:
        widths = [max(len(str(c)), max(len(str(r[c] if r[c] is not None else "")) for r in rows))
                  for c in cols]
        print("  ".join(str(c).upper().ljust(w) for c, w in zip(cols, widths)))
        for r in rows:
            print("  ".join(str(r[c] if r[c] is not None else "").ljust(w)
                            for c, w in zip(cols, widths)))
    if cur.rowcount == -1 and len(cur.fetchall()) == 0 and len(rows) == args.limit:
        print(f"\n(showing first {args.limit} rows)")


if __name__ == "__main__":
    main()
