// 共享启动逻辑：打开数据库、迁移、组装 store 与引擎。
import { join } from "node:path";
import type { AppConfig } from "../config/index.ts";
import { buildEngine } from "../agent/factory.ts";
import type { DiagnosisEngine } from "../agent/types.ts";
import { migrate, openDatabase, type Db } from "../storage/db.ts";
import { Store } from "../storage/store.ts";

export interface Bootstrap {
  db: Db;
  store: Store;
  engine: DiagnosisEngine;
}

export function bootstrap(config: AppConfig): Bootstrap {
  const db = openDatabase(config.dbPath);
  migrate(db, join(config.projectRoot, "migrations"));
  return { db, store: new Store(db), engine: buildEngine(config) };
}
