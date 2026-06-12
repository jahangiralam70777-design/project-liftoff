import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertPermission } from "@/lib/admin-permissions";
import { sanitizeSearchTerm } from "@/lib/admin-search-sanitize";
import { z } from "zod";

// Tables we block from writes/deletes via the Database Manager — manage them
// through their dedicated admin screens.
export const PROTECTED_WRITE_TABLES = new Set<string>([
  "user_roles",
  "site_settings",
  "module_visibility",
]);

// Backwards-compat re-export so any older imports of `INSPECTABLE_TABLES` keep
// resolving. The UI now discovers tables dynamically via adminListPublicTables.
export const INSPECTABLE_TABLES = [] as const;
export type InspectableTable = string;

// Columns whose values must never leave the server, even for admins. Matched
// case-insensitively against the column name. Defense-in-depth — sensitive
// fields (auth hashes, API keys, OAuth tokens, webhook secrets) should not be
// stored in app tables in the first place, but if they ever are, this layer
// scrubs them out of the row viewer / CSV export / detail drawer.
const SENSITIVE_COLUMN_PATTERNS: RegExp[] = [
  /password/i,
  /secret/i,
  /api[_-]?key/i,
  /access[_-]?token|refresh[_-]?token|id[_-]?token|bearer/i,
  /private[_-]?key/i,
  /service[_-]?role/i,
  /webhook[_-]?secret/i,
  /encryption[_-]?key|signing[_-]?key/i,
];
const REDACTED = "•••••• (redacted)";
function redactRow<T extends Record<string, unknown>>(row: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] =
      SENSITIVE_COLUMN_PATTERNS.some((re) => re.test(k)) && v !== null && v !== undefined
        ? REDACTED
        : v;
  }
  return out as T;
}

const IDENT = /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function assertTableExists(supabase: any, table: string): Promise<void> {
  if (!IDENT.test(table)) throw new Error("Invalid table name");
  const { data, error } = await supabase.rpc("admin_list_public_tables");
  if (error) throw new Error(error.message);
  const known = new Set((data as Array<{ table_name: string }>).map((t) => t.table_name));
  if (!known.has(table)) throw new Error(`Unknown table: ${table}`);
}

export type PublicTableInfo = {
  table_name: string;
  size_bytes: number;
  row_estimate: number;
  rls_enabled: boolean;
};

export const adminListPublicTables = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<PublicTableInfo[]> => {
    await assertPermission(context.supabase, context.userId, "manage_system");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (context.supabase as any).rpc("admin_list_public_tables");
    if (error) throw new Error(error.message);
    return (data ?? []) as PublicTableInfo[];
  });

export type TableMetadata = {
  table: string;
  primary_key: string[];
  columns: Array<{
    name: string;
    data_type: string;
    is_nullable: boolean;
    default: string | null;
    ordinal_position: number;
    is_pk: boolean;
  }>;
  foreign_keys: Array<{
    constraint_name: string;
    columns: string[];
    foreign_table: string;
    foreign_columns: string[];
  }>;
  referenced_by: Array<{
    constraint_name: string;
    from_table: string;
    from_columns: string[];
    columns: string[];
  }>;
  indexes: Array<{ name: string; definition: string }>;
  policies: Array<{
    name: string;
    command: string;
    roles: string[];
    permissive: string;
    using: string | null;
    with_check: string | null;
  }>;
};

export const adminGetTableMetadata = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ table: z.string().min(1).max(63) }).parse(input))
  .handler(async ({ data, context }): Promise<TableMetadata> => {
    await assertPermission(context.supabase, context.userId, "manage_system");
    await assertTableExists(context.supabase, data.table);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: meta, error } = await (context.supabase as any).rpc("admin_table_metadata", {
      _table: data.table,
    });
    if (error) throw new Error(error.message);
    return meta as TableMetadata;
  });

const listInput = z.object({
  table: z.string().min(1).max(63),
  page: z.number().int().min(0).max(10000).default(0),
  pageSize: z.number().int().min(1).max(100).default(25),
  search: z.string().max(200).optional(),
  sortColumn: z.string().min(1).max(63).optional(),
  sortDir: z.enum(["asc", "desc"]).default("desc"),
});

type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };
export type TableRow = Record<string, JsonValue>;
export type TableRowsResult = {
  table: string;
  rows: TableRow[];
  total: number;
  page: number;
  pageSize: number;
  columns: string[];
};

export const adminListTableRows = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => listInput.parse(input))
  .handler(async ({ data, context }): Promise<TableRowsResult> => {
    await assertPermission(context.supabase, context.userId, "manage_system");
    await assertTableExists(context.supabase, data.table);
    const { table, page, pageSize, search, sortColumn, sortDir } = data;
    const from = page * pageSize;
    const to = from + pageSize - 1;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let query = (context.supabase as any).from(table).select("*", { count: "exact" });
    if (search && search.trim()) {
      // H-1: strip PostgREST `.or()` and ilike meta-chars so a `,` or `)`
      // in the user's search can't break out of the filter expression.
      const term = sanitizeSearchTerm(search.trim());
      if (term) {
        const pattern = `%${term}%`;
        const candidates = [
          "name",
          "title",
          "email",
          "label",
          "key",
          "slug",
          "display_name",
          "question",
          "description",
        ];
        const filters = candidates.map((c) => `${c}.ilike.${pattern}`).join(",");
        query = query.or(filters);
      }
    }
    const orderCol = sortColumn && IDENT.test(sortColumn) ? sortColumn : "created_at";
    const ordered = query.order(orderCol, { ascending: sortDir === "asc", nullsFirst: false });
    let res = await ordered.range(from, to);
    if (res.error) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      res = await (context.supabase as any)
        .from(table)
        .select("*", { count: "exact" })
        .range(from, to);
    }
    if (res.error) throw new Error(res.error.message);
    const rows = (res.data ?? []) as unknown as TableRow[];
    const safeRows = rows.map((r) => redactRow(r));
    const columns = safeRows[0] ? Object.keys(safeRows[0]) : [];
    return { table, rows: safeRows, total: res.count ?? rows.length, page, pageSize, columns };
  });

const deleteInput = z.object({
  table: z.string().min(1).max(63),
  id: z.string().min(1).max(200),
  idColumn: z.string().min(1).max(64).default("id"),
});

export const adminDeleteTableRow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => deleteInput.parse(input))
  .handler(async ({ data, context }) => {
    await assertPermission(context.supabase, context.userId, "manage_system", "db.delete_row", {
      table: data.table,
      id: data.id,
      id_column: data.idColumn,
    });
    await assertTableExists(context.supabase, data.table);
    if (PROTECTED_WRITE_TABLES.has(data.table)) {
      throw new Error(`Row deletion is disabled on protected table "${data.table}".`);
    }
    if (!IDENT.test(data.idColumn)) throw new Error("Invalid id column");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (context.supabase as any)
      .from(data.table)
      .delete()
      .eq(data.idColumn, data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

const bulkDeleteInput = z.object({
  table: z.string().min(1).max(63),
  ids: z.array(z.string().min(1).max(200)).min(1).max(500),
  idColumn: z.string().min(1).max(64).default("id"),
});

export const adminBulkDeleteTableRows = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => bulkDeleteInput.parse(input))
  .handler(async ({ data, context }) => {
    await assertPermission(
      context.supabase,
      context.userId,
      "manage_system",
      "db.bulk_delete_rows",
      {
        table: data.table,
        id_count: data.ids.length,
        id_column: data.idColumn,
      },
    );
    await assertTableExists(context.supabase, data.table);
    if (PROTECTED_WRITE_TABLES.has(data.table)) {
      throw new Error(`Bulk delete is disabled on protected table "${data.table}".`);
    }
    if (!IDENT.test(data.idColumn)) throw new Error("Invalid id column");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error, count } = await (context.supabase as any)
      .from(data.table)
      .delete({ count: "exact" })
      .in(data.idColumn, data.ids);
    if (error) throw new Error(error.message);
    return { ok: true, deleted: count ?? data.ids.length };
  });

const writeInput = z.object({
  table: z.string().min(1).max(63),
  values: z.record(z.string().min(1).max(63), z.unknown()),
  id: z.string().min(1).max(200).optional(),
  idColumn: z.string().min(1).max(64).default("id"),
});

export const adminUpsertTableRow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => writeInput.parse(input))
  .handler(async ({ data, context }) => {
    await assertPermission(
      context.supabase,
      context.userId,
      "manage_system",
      data.id ? "db.update_row" : "db.insert_row",
      { table: data.table, id: data.id ?? null, columns: Object.keys(data.values) },
    );
    await assertTableExists(context.supabase, data.table);
    if (PROTECTED_WRITE_TABLES.has(data.table)) {
      throw new Error(`Writes are disabled on protected table "${data.table}".`);
    }
    if (!IDENT.test(data.idColumn)) throw new Error("Invalid id column");
    for (const k of Object.keys(data.values)) {
      if (!IDENT.test(k)) throw new Error(`Invalid column name: ${k}`);
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sb: any = context.supabase;
    if (data.id) {
      const { data: out, error } = await sb
        .from(data.table)
        .update(data.values)
        .eq(data.idColumn, data.id)
        .select()
        .maybeSingle();
      if (error) throw new Error(error.message);
      return { ok: true, row: out };
    }
    const { data: out, error } = await sb
      .from(data.table)
      .insert(data.values)
      .select()
      .maybeSingle();
    if (error) throw new Error(error.message);
    return { ok: true, row: out };
  });

/**
 * C-1: SELECT-only allow-list for the admin database inspector.
 *
 * The underlying RPC `admin_run_select_query` is the database-level gate;
 * this TypeScript layer adds defense-in-depth so a compromised admin
 * session cannot smuggle DDL/DML through the inspector even if the RPC's
 * own checks are bypassed or relaxed. Rules:
 *  - Strip a single trailing semicolon, then reject if any `;` remains
 *    (no multi-statement scripts).
 *  - Strip line + block comments before keyword inspection so a leading
 *    `/* … *​/ DELETE …` cannot disguise the real statement.
 *  - Require the first token to be `SELECT` or `WITH` (CTE → SELECT).
 *  - Reject any forbidden keyword on a word boundary anywhere in the
 *    statement (INSERT/UPDATE/DELETE/etc., plus `INTO` which would turn
 *    a SELECT into a write via `SELECT … INTO`).
 *
 * Fails closed: any violation throws before the RPC is invoked.
 */
const FORBIDDEN_SQL_KEYWORDS = [
  "INSERT",
  "UPDATE",
  "DELETE",
  "MERGE",
  "UPSERT",
  "DROP",
  "ALTER",
  "CREATE",
  "TRUNCATE",
  "RENAME",
  "GRANT",
  "REVOKE",
  "COMMENT",
  "REINDEX",
  "REFRESH",
  "VACUUM",
  "ANALYZE",
  "CLUSTER",
  "LOCK",
  "COPY",
  "CALL",
  "DO",
  "EXECUTE",
  "PREPARE",
  "DEALLOCATE",
  "LISTEN",
  "NOTIFY",
  "UNLISTEN",
  "SET",
  "RESET",
  "SHOW",
  "BEGIN",
  "COMMIT",
  "ROLLBACK",
  "SAVEPOINT",
  "START",
  "INTO",
];
const FORBIDDEN_SQL_RE = new RegExp(`\\b(${FORBIDDEN_SQL_KEYWORDS.join("|")})\\b`, "i");

function assertSelectOnly(rawSql: string): string {
  // Strip block comments /* ... */ and line comments -- ... \n before
  // keyword inspection, then trim and remove a single trailing ;
  const stripped = rawSql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n\r]*/g, " ")
    .trim()
    .replace(/;\s*$/, "")
    .trim();
  if (!stripped) throw new Error("Empty SQL");
  if (stripped.includes(";")) {
    throw new Error("Only a single SQL statement is allowed");
  }
  const first = stripped.match(/^[A-Za-z]+/)?.[0]?.toUpperCase();
  if (first !== "SELECT" && first !== "WITH") {
    throw new Error("Only SELECT (or WITH … SELECT) queries are allowed");
  }
  const forbidden = stripped.match(FORBIDDEN_SQL_RE);
  if (forbidden) {
    throw new Error(`Forbidden keyword in SQL: ${forbidden[1].toUpperCase()}`);
  }
  return stripped;
}

export const adminRunSelectQuery = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        sql: z.string().min(1).max(5000),
        maxRows: z.number().int().min(1).max(1000).default(200),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    // Defense-in-depth: validate before we even check permission so
    // a forbidden statement never reaches the audit log as "attempted".
    const safeSql = assertSelectOnly(data.sql);
    await assertPermission(
      context.supabase,
      context.userId,
      "manage_system",
      "db.run_select_query",
      {
        sql_preview: safeSql.slice(0, 200),
        max_rows: data.maxRows,
      },
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: out, error } = await (context.supabase as any).rpc("admin_run_select_query", {
      _sql: safeSql,
      _max_rows: data.maxRows,
    });
    if (error) throw new Error(error.message);
    return out as unknown as {
      rows: Array<Record<string, string | number | boolean | null>>;
      limit: number;
    };
  });

export const adminGlobalSearch = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        term: z.string().min(2).max(200),
        limit: z.number().int().min(1).max(200).default(50),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    await assertPermission(context.supabase, context.userId, "manage_system");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: rows, error } = await (context.supabase as any).rpc("admin_global_search", {
      _term: data.term,
      _limit: data.limit,
    });
    if (error) throw new Error(error.message);
    return (rows ?? []) as Array<{ table_name: string; id: string; snippet: string }>;
  });
