import { randomBytes } from 'node:crypto';
import type { DatabaseHost } from '@prisma/client';
import mysql from 'mysql2/promise';
import type { Encrypter } from '../../lib/crypto';
import { HttpError } from '../../lib/errors';

/** Privileges a server's database user gets on its own database (matches Pterodactyl). */
const GRANTS = [
  'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'DROP', 'ALTER', 'INDEX', 'LOCK TABLES', 'CREATE TEMPORARY TABLES',
  'EXECUTE', 'CREATE VIEW', 'SHOW VIEW', 'CREATE ROUTINE', 'ALTER ROUTINE', 'EVENT', 'TRIGGER', 'REFERENCES',
].join(', ');

export const IDENTIFIER = /^[A-Za-z0-9_]{1,64}$/;
export const REMOTE = /^[0-9A-Za-z.%_:-]{1,255}$/;

export function generatePassword() {
  // Alphanumeric only: users paste these into config files where quoting is error-prone.
  return randomBytes(32).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 24);
}

function quoteIdent(name: string) {
  if (!IDENTIFIER.test(name)) throw new HttpError(422, 'validation', `"${name}" is not a valid database name.`);
  return `\`${name}\``;
}

export interface HostCredentials {
  host: string;
  port: number;
  username: string;
  password: string;
}

export function hostCredentials(host: DatabaseHost, encrypter: Encrypter): HostCredentials {
  return { host: host.host, port: host.port, username: host.username, password: encrypter.decrypt(host.passwordEncrypted) };
}

/** Open a connection to a database host, run `fn`, and always close it. */
export async function withHost<T>(creds: HostCredentials, fn: (conn: mysql.Connection) => Promise<T>): Promise<T> {
  let conn: mysql.Connection;
  try {
    conn = await mysql.createConnection({ host: creds.host, port: creds.port, user: creds.username, password: creds.password, connectTimeout: 5_000 });
  } catch (err) {
    throw new HttpError(502, 'database_host_unreachable', `Could not connect to the database host: ${(err as Error).message}`);
  }
  try {
    return await fn(conn);
  } finally {
    await conn.end().catch(() => undefined);
  }
}

/** Check the admin's credentials can create databases and users. */
export async function testHost(creds: HostCredentials): Promise<string> {
  return withHost(creds, async (conn) => {
    const [rows] = await conn.query('SELECT VERSION() AS version');
    return String((rows as { version: string }[])[0]?.version ?? 'unknown');
  });
}

export async function createDatabase(creds: HostCredentials, db: { database: string; username: string; remote: string; password: string; maxConnections: number }) {
  await withHost(creds, async (conn) => {
    await conn.query(`CREATE DATABASE ${quoteIdent(db.database)}`);
    try {
      await conn.query('CREATE USER ?@? IDENTIFIED BY ?', [db.username, db.remote, db.password]);
      try {
        await conn.query(`GRANT ${GRANTS} ON ${quoteIdent(db.database)}.* TO ?@?`, [db.username, db.remote]);
        if (db.maxConnections > 0) {
          await conn.query('ALTER USER ?@? WITH MAX_USER_CONNECTIONS ?', [db.username, db.remote, db.maxConnections]);
        }
        await conn.query('FLUSH PRIVILEGES');
      } catch (err) {
        await conn.query('DROP USER IF EXISTS ?@?', [db.username, db.remote]).catch(() => undefined);
        throw err;
      }
    } catch (err) {
      await conn.query(`DROP DATABASE IF EXISTS ${quoteIdent(db.database)}`).catch(() => undefined);
      throw new HttpError(502, 'database_error', `The database host refused: ${(err as Error).message}`);
    }
  });
}

export async function rotatePassword(creds: HostCredentials, db: { username: string; remote: string }, password: string) {
  await withHost(creds, async (conn) => {
    await conn.query('ALTER USER ?@? IDENTIFIED BY ?', [db.username, db.remote, password]);
    await conn.query('FLUSH PRIVILEGES');
  });
}

export async function dropDatabase(creds: HostCredentials, db: { database: string; username: string; remote: string }) {
  await withHost(creds, async (conn) => {
    await conn.query(`DROP DATABASE IF EXISTS ${quoteIdent(db.database)}`);
    await conn.query('DROP USER IF EXISTS ?@?', [db.username, db.remote]);
    await conn.query('FLUSH PRIVILEGES');
  });
}
