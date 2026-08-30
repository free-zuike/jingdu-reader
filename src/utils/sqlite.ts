// SQLite 解析器（cloudflare-worker-sqlite-wasm）
// sql.js 官方版在 Workers 上无法运行（WebAssembly.instantiate 禁止运行时编译原始字节）；
// 该 fork 通过 instantiateWasm 回调接收 wrangler [wasm_modules] 预编译模块，可在 Workers 上运行。

import initSqlJs from 'cloudflare-worker-sqlite-wasm';
import sqlCfWasm from '../wasm/sql-cf-wasm.wasm';

type SQLValue = number | string | Uint8Array | null;

export interface QueryResult {
  columns: string[];
  values: SQLValue[][];
}

export interface SQLiteDatabase {
  exec(sql: string, params?: SQLValue[] | Record<string, SQLValue> | null): QueryResult[];
  close(): void;
}

export type SqlJsStatic = {
  Database: new (data?: ArrayLike<number> | null) => SQLiteDatabase;
};

let cachedSQL: SqlJsStatic | null = null;

export async function getSQL(): Promise<SqlJsStatic> {
  if (cachedSQL) return cachedSQL;
  cachedSQL = await initSqlJs({
    instantiateWasm(info: any, receive: any) {
      const instance = new WebAssembly.Instance(sqlCfWasm, info);
      receive(instance);
      return instance.exports;
    },
    log: () => {},
    error: (err: unknown) => console.error('[SQLite]', err),
  } as any) as unknown as SqlJsStatic;
  return cachedSQL;
}

export function openDatabase(bytes: Uint8Array): SQLiteDatabase {
  const SQL = cachedSQL!;
  return new SQL.Database(bytes);
}

export async function openDatabaseAsync(bytes: Uint8Array): Promise<SQLiteDatabase> {
  const SQL = await getSQL();
  return new SQL.Database(bytes);
}
