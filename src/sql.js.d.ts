declare module 'sql.js' {
    export interface SqlJsStatic {
        Database: typeof Database;
    }

    export interface Database {
        run(sql: string, params?: any): Database;
        exec(sql: string): QueryExecResult[];
        each(sql: string, params?: any, callback?: (row: any) => void, done?: () => void): void;
        prepare(sql: string, params?: any): Statement;
        export(): Uint8Array;
        close(): void;
        getRowsModified(): number;
    }

    export interface Statement {
        bind(params?: any): boolean;
        step(): boolean;
        getColumnNames(): string[];
        get(params?: any): any[];
        getAsObject(params?: any): any;
        run(params?: any): void;
        reset(): void;
        free(): boolean;
    }

    export interface QueryExecResult {
        columns: string[];
        values: any[][];
    }

    export interface SqlJsConfig {
        locateFile?: (filename: string) => string;
    }

    export default function initSqlJs(config?: SqlJsConfig): Promise<SqlJsStatic>;
}
