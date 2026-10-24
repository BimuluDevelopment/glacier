import { createHash } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { FileError, type ServerFilesystem } from './files';

/** Largest single download (the server's disk limit still applies on top). */
const MAX_BYTES = 512 * 1024 * 1024;
const MAX_REDIRECTS = 5;

export interface PullRequest {
  url: string;
  /** Server-relative directory, e.g. "/plugins". */
  directory: string;
  filename: string;
  /** Expected hash (any one); the file is discarded on mismatch. */
  sha1?: string;
  sha256?: string;
  sha512?: string;
}

function hostAllowed(host: string, allowed: readonly string[]) {
  const h = host.toLowerCase();
  return allowed.some((a) => (a.startsWith('*.') ? h.endsWith(a.slice(1)) || h === a.slice(2) : h === a));
}

/**
 * Download a file into a server. Only https URLs on allow-listed hosts are fetched, every redirect
 * hop is re-checked (so an allowed CDN can't bounce us to an internal address), the size is
 * capped, and the hash must match before the file appears under its real name.
 */
export async function pullFile(fs: ServerFilesystem, req: PullRequest, allowedHosts: readonly string[]) {
  if (!/^[\w.+() -]{1,200}$/.test(req.filename) || req.filename.startsWith('.')) throw new FileError('Invalid file name.');
  const algo = req.sha512 ? 'sha512' : req.sha256 ? 'sha256' : req.sha1 ? 'sha1' : null;
  const expected = (req.sha512 ?? req.sha256 ?? req.sha1)?.toLowerCase();

  let url = new URL(req.url);
  let res: Response | null = null;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (url.protocol !== 'https:' || !hostAllowed(url.hostname, allowedHosts)) {
      throw new FileError(`Downloads from ${url.hostname} are not allowed on this node.`, 403);
    }
    res = await fetch(url, { redirect: 'manual', headers: { 'user-agent': 'glacierd/0.1' }, signal: AbortSignal.timeout(60_000) });
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      url = new URL(location, url);
      continue;
    }
    break;
  }
  if (!res || !res.ok || !res.body) throw new FileError(`Download failed (HTTP ${res?.status ?? '?'}).`, 502);
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > MAX_BYTES) throw new FileError('That file is too large to download.', 413);

  const hash = algo ? createHash(algo) : null;
  let total = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      total += chunk.length;
      if (total > MAX_BYTES) return cb(new FileError('That file is too large to download.', 413));
      hash?.update(chunk);
      cb(null, chunk);
    },
  });

  const dir = req.directory.replace(/\/+$/, '') || '';
  const temp = `${dir}/.${req.filename}.part`;
  const body = Readable.fromWeb(res.body as unknown as WebReadableStream).pipe(meter);
  await fs.write(temp, body);
  if (hash && expected && hash.digest('hex') !== expected) {
    await fs.delete(dir || '/', [`.${req.filename}.part`]);
    throw new FileError('The downloaded file did not match its checksum and was discarded.', 502);
  }
  await fs.delete(dir || '/', [req.filename]).catch(() => undefined);
  await fs.rename(dir || '/', [{ from: `.${req.filename}.part`, to: req.filename }]);
  return { path: `${dir}/${req.filename}`, bytes: total };
}
