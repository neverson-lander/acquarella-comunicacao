import pg from 'pg';

// Millisecond timestamps fit safely within JavaScript's integer range.
pg.types.setTypeParser(20, value => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error('Inteiro fora do intervalo seguro.');
  return parsed;
});

export function databaseOptions() {
  const value = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!value) throw new Error('Conexão com o Supabase não configurada.');
  const url = new URL(value);
  for (const name of ['sslmode', 'sslcert', 'sslkey', 'sslrootcert', 'pgbouncer']) url.searchParams.delete(name);
  return {
    connectionString: url.href,
    max: 3,
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 15000,
    ssl: { rejectUnauthorized: true, ...(process.env.POSTGRES_CA ? { ca: process.env.POSTGRES_CA } : {}) },
  };
}

export const pool = globalThis.__acquarellaPool ??= new pg.Pool(databaseOptions());
