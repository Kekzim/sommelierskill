import { DatabaseSync } from "node:sqlite";
import { statSync } from "node:fs";
import { SQL_ROW_CAP, SQL_TIMEOUT_MS } from "./constants.js";

/**
 * Read-only access to the bolagetdb mirror.
 *
 * The sync job writes a fresh database and renames it over this path, which is
 * atomic for the filesystem but NOT for us: an open SQLite handle keeps reading
 * the old inode and would serve yesterday's assortment forever, with nothing
 * failing. So the inode is checked before each use and the handle reopened when
 * it has changed.
 *
 * Reads are synchronous. node:sqlite has no async API, and for a local file
 * answering a single user that is the simpler correct choice -- the queries here
 * are indexed lookups over ~27k rows, not scans.
 */
export class Mirror {
  private db: DatabaseSync | null = null;
  private inode: bigint | number | null = null;

  constructor(private readonly path: string) {}

  /** The live handle, reopened if the file underneath has been swapped. */
  private handle(): DatabaseSync {
    let ino: bigint | number;
    try {
      ino = statSync(this.path).ino;
    } catch (err) {
      throw new Error(
        `No database at ${this.path}. Run \`bolagetdb sync\` to build the mirror, ` +
          `or point BOLAGETDB_PATH at an existing one. (${(err as Error).message})`,
      );
    }
    if (this.db && this.inode === ino) return this.db;

    this.db?.close();
    // readOnly keeps this process incapable of writing to the mirror at all,
    // which is the guarantee the query tool leans on.
    this.db = new DatabaseSync(this.path, { readOnly: true });
    this.db.exec(`PRAGMA busy_timeout = ${SQL_TIMEOUT_MS}`);
    this.inode = ino;
    return this.db;
  }

  /** Run a parameterised read. */
  all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[] {
    const stmt = this.handle().prepare(sql);
    return stmt.all(...(params as never[])) as T[];
  }

  /** Run a read expected to yield at most one row. */
  get<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T | undefined {
    return this.all<T>(sql, ...params)[0];
  }

  /**
   * Run caller-supplied SQL. Only a single SELECT/WITH statement is allowed,
   * and a row cap is imposed when the query does not impose its own.
   *
   * The read-only handle is what actually prevents writes; this validation is
   * about giving a clear error rather than a confusing SQLite one, and about
   * refusing statements that are read-only yet still hostile (ATTACH reaching
   * other files, PRAGMA changing behaviour).
   */
  query(sql: string): { rows: Record<string, unknown>[]; capped: boolean } {
    const trimmed = sql.trim().replace(/;\s*$/, "");
    if (!trimmed) throw new Error("Empty query.");
    if (trimmed.includes(";")) {
      throw new Error("Only a single statement is allowed; remove the ';'.");
    }
    if (!/^(select|with)\b/i.test(trimmed)) {
      throw new Error(
        "Only SELECT (or WITH ... SELECT) queries are allowed. This tool reads the mirror; it cannot modify it.",
      );
    }
    if (/\b(attach|detach|pragma|vacuum)\b/i.test(trimmed)) {
      throw new Error(
        "ATTACH, DETACH, PRAGMA and VACUUM are not allowed. Query the product, product_grape, product_pairing, product_fts, store and store_product tables directly.",
      );
    }

    const capped = !/\blimit\b/i.test(trimmed);
    const final = capped ? `${trimmed} LIMIT ${SQL_ROW_CAP}` : trimmed;

    return { rows: this.handle().prepare(final).all() as Record<string, unknown>[], capped };
  }

  close(): void {
    this.db?.close();
    this.db = null;
    this.inode = null;
  }
}
