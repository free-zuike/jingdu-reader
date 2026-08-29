declare module 'sql.js' {
  export interface QueryExecResult {
    columns: string[];
    values: any[][];
  }

  export interface Database {
    exec(sql: string, params?: any[]): QueryExecResult[];
    close(): void;
  }

  export interface SqlJsInstance {
    Database: new (data?: Uint8Array | ArrayBuffer | number[]) => Database;
  }

  export function initSqlJs(config?: any): Promise<SqlJsInstance>;
  export default initSqlJs;
}