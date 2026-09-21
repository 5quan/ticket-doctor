// 存储基础：打开 SQLite、WAL、迁移、短事务。
//
// 选 node:sqlite（Node 22+ 内置）而不是 better-sqlite3：避免原生编译依赖，
// API 同样同步，足够单机 4 worker 的短事务场景。
//
// 事务铁律：模型调用、日志查询、飞书发送一律在事务外；事务里只碰数据库。
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

export type Db = DatabaseSync;

export function openDatabase(dbPath: string): Db {
  if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA synchronous = NORMAL;");
  return db;
}

/** 按文件名升序应用未执行的迁移；每个文件一个事务。 */
export function migrate(db: Db, migrationsDir: string): string[] {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)",
  );
  const applied = new Set(
    (db.prepare("SELECT version FROM schema_migrations").all() as Array<{ version: string }>).map(
      (r) => r.version,
    ),
  );
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const ran: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(`${migrationsDir}/${file}`, "utf8");
    transaction(db, () => {
      db.exec(sql);
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(
        file,
        Date.now(),
      );
    });
    ran.push(file);
  }
  return ran;
}

/** 短事务：BEGIN IMMEDIATE 立刻取写锁，避免"先读后写"的竞态。 */
export function transaction<T>(db: Db, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // 回滚失败不掩盖原始错误
    }
    throw err;
  }
}

/** node:sqlite 的数值列可能回传 bigint，统一收敛成 number。 */
export function asNumber(value: unknown): number {
  return typeof value === "bigint" ? Number(value) : (value as number);
}
