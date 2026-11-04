import { Pool, type QueryResult, type QueryResultRow } from "pg";

declare global {
  // Reuse one pool across Next.js hot reloads in development.
  var fusionMusicPool: Pool | undefined;
}

function createPool(): Pool {
  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    throw new Error("DATABASE_URL is not configured");
  }

  const sslMode = new URL(connectionString).searchParams.get("sslmode");
  const ssl = sslMode && sslMode !== "disable"
    ? { rejectUnauthorized: sslMode === "verify-ca" || sslMode === "verify-full" }
    : undefined;

  return new Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    ssl,
  });
}

export function getPool(): Pool {
  if (!global.fusionMusicPool) {
    global.fusionMusicPool = createPool();
  }

  return global.fusionMusicPool;
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  values: unknown[] = [],
): Promise<QueryResult<T>> {
  return getPool().query<T>(text, values);
}
