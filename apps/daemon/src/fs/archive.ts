import { createWriteStream } from 'node:fs';
import { mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { create as tarCreate, extract as tarExtract } from 'tar';
import yauzl from 'yauzl';
import { PathMatcher } from '@glacier/shared';
import { isInside } from './sandbox';
import { FileError, type Quota } from './files';

export function archiveKind(file: string): 'tar' | 'zip' | null {
  const name = file.toLowerCase();
  if (name.endsWith('.tar.gz') || name.endsWith('.tgz') || name.endsWith('.tar')) return 'tar';
  if (name.endsWith('.zip') || name.endsWith('.jar') || name.endsWith('.mrpack')) return 'zip';
  return null;
}

/** Create a .tar.gz of `entries` (paths relative to `cwd`), skipping anything `ignore` matches. */
export async function createTarGz(cwd: string, entries: string[], target: string, ignore: string[] = []): Promise<void> {
  const matcher = new PathMatcher(ignore);
  await tarCreate(
    {
      gzip: true,
      cwd,
      file: target,
      portable: true,
      // When creating, node-tar passes fs.Stats (ReadEntry only appears while extracting).
      filter: (p, stat) => matcher.empty || !matcher.matches(p.replace(/^\.\//, ''), 'isDirectory' in stat && stat.isDirectory()),
    },
    entries,
  );
}

/**
 * Extract an archive into `dest`. Entries that would land outside `dest` (zip-slip), links and
 * device files are skipped, and the uncompressed size counts against the server's quota.
 */
export async function extractArchive(file: string, dest: string, quota: Quota): Promise<void> {
  const kind = archiveKind(file);
  if (!kind) throw new FileError('Only .zip, .tar, .tar.gz and .tgz archives can be extracted.');
  const destReal = await realpath(dest);
  if (kind === 'tar') return extractTar(file, destReal, quota);
  return extractZip(file, destReal, quota);
}

async function extractTar(file: string, dest: string, quota: Quota) {
  let budget = await quota.remaining();
  let overQuota = false;
  await tarExtract({
    file,
    cwd: dest,
    strict: true,
    // node-tar already strips ".." and absolute paths; also refuse links and special files.
    filter: (_p, entry) => {
      const type = (entry as { type?: string }).type;
      if (type && type !== 'File' && type !== 'OldFile' && type !== 'ContiguousFile' && type !== 'Directory') return false;
      const size = (entry as { size?: number }).size ?? 0;
      if (overQuota || budget - size < 0) {
        // Errors thrown here are swallowed by node-tar, so skip the rest and report afterwards.
        overQuota = true;
        return false;
      }
      budget -= size;
      quota.add(size);
      return true;
    },
  });
  if (overQuota) throw new FileError('The server ran out of disk space; the archive was only partly extracted.', 507);
}

function extractZip(file: string, dest: string, quota: Quota): Promise<void> {
  return new Promise((resolve, reject) => {
    // decodeStrings: false so one malicious name ("../x") is skipped by our own check below
    // instead of yauzl failing the whole archive.
    yauzl.open(file, { lazyEntries: true, autoClose: true, decodeStrings: false }, (err, zip) => {
      if (err || !zip) return reject(new FileError(`Could not open archive: ${err?.message ?? 'unknown error'}`));
      let failed = false;
      const fail = (e: Error) => {
        if (failed) return;
        failed = true;
        zip.close();
        reject(e);
      };

      void quota.remaining().then((initial) => {
        let budget = initial;
        zip.on('error', fail);
        zip.on('end', () => !failed && resolve());
        zip.on('entry', (entry: yauzl.Entry) => {
          const raw = entry.fileName as unknown as Buffer;
          // Bit 11 marks UTF-8 names; older zips use CP437, which latin1 matches for ASCII.
          const fileName = raw.toString(entry.generalPurposeBitFlag & 0x800 ? 'utf8' : 'latin1').replace(/\\/g, '/');
          const target = path.resolve(dest, fileName);
          const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
          if (!isInside(dest, target) || mode === 0o120000) {
            zip.readEntry();
            return;
          }
          if (fileName.endsWith('/')) {
            mkdir(target, { recursive: true }).then(() => zip.readEntry(), fail);
            return;
          }
          budget -= entry.uncompressedSize;
          if (budget < 0) return fail(new FileError('Extracting this archive would exceed the server disk limit.', 507));

          zip.openReadStream(entry, (streamErr, stream) => {
            if (streamErr || !stream) return fail(streamErr ?? new Error('Unreadable entry'));
            let written = 0;
            // Trust the bytes we actually write, not the size the zip claims (zip bombs).
            const counter = new Transform({
              transform(chunk: Buffer, _enc, cb) {
                written += chunk.length;
                if (written > entry.uncompressedSize) return cb(new FileError('Archive entry is larger than it claims.'));
                cb(null, chunk);
              },
            });
            mkdir(path.dirname(target), { recursive: true })
              .then(() => pipeline(stream, counter, createWriteStream(target)))
              .then(() => {
                quota.add(written);
                zip.readEntry();
              }, fail);
          });
        });
        zip.readEntry();
      }, fail);
    });
  });
}
