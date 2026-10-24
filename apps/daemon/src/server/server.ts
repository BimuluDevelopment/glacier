import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createReadStream } from 'node:fs';
import { appendFile, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type Docker from 'dockerode';
import type { ConfigFile, PowerAction, ProcessState, ResourceSample, ServerConfiguration, ServerResourceUsage } from '@glacier/shared';
import type { DaemonConfig } from '../config';
import type { Logger } from '../logger';
import type { PanelClient } from '../panel';
import { isNotFound, pullImage } from '../docker/docker';
import { cpuPercent, installContainerSpec, memoryUsage, networkTotals, serverContainerSpec } from '../docker/spec';
import { createTarGz, extractArchive } from '../fs/archive';
import { ServerFilesystem } from '../fs/files';
import { directorySize } from '../fs/sandbox';
import { chownPath, chownRecursive } from '../fs/ownership';
import { applyConfigFiles } from './config-files';

const CONSOLE_HISTORY = 150;
const MAX_LINES_PER_SECOND = 2000;
const DISK_CHECK_INTERVAL_MS = 60_000;
const HISTORY_INTERVAL_MS = 10_000;
const HISTORY_LENGTH = 360; // one hour
// eslint-disable-next-line no-control-regex -- matching ANSI escape codes is the point
const ANSI =/\x1b\[[0-9;?]*[ -/]*[@-~]/g;

export class ServerError extends Error {
  constructor(
    message: string,
    public readonly statusCode = 409,
  ) {
    super(message);
  }
}

export interface ServerEvents {
  console: [line: string];
  install: [line: string];
  state: [state: ProcessState];
  stats: [usage: ServerResourceUsage];
  'install-started': [];
  'install-completed': [successful: boolean];
  'backup-completed': [backup: string, successful: boolean];
  'restore-completed': [backup: string, successful: boolean];
  /** Users whose console access was revoked; their open sockets should close. */
  deny: [users: string[]];
  message: [text: string];
}

/** One game server on this node: its container, console, resource usage and install process. */
export class ServerInstance extends EventEmitter<ServerEvents> {
  state: ProcessState = 'offline';
  installing = false;
  restoring = false;
  readonly fs: ServerFilesystem;
  /** Tokens issued before these times (ms) are rejected, per user id. */
  private readonly denyBefore = new Map<string, number>();

  private stream: NodeJS.ReadWriteStream | null = null;
  private statsStream: NodeJS.ReadableStream | null = null;
  private history: string[] = [];
  private decoder = new StringDecoder('utf8');
  private partial = '';
  private expectingExit = false;
  private lastCrashAt = 0;
  private startedAt = 0;
  private linesThisSecond = 0;
  private throttleWindow = 0;
  private powerQueue: Promise<unknown> = Promise.resolve();
  private usage = { cpu: 0, memory: 0, rx: 0, tx: 0 };
  /** Resource samples for the last hour, for the console graphs. */
  private samples: ResourceSample[] = [];
  private disk = { bytes: 0, checkedAt: 0, pending: null as Promise<number> | null };

  constructor(
    public config: ServerConfiguration,
    private readonly daemon: DaemonConfig,
    private readonly docker: Docker,
    private readonly panel: PanelClient,
    private readonly log: Logger,
  ) {
    super();
    this.setMaxListeners(100);
    this.fs = new ServerFilesystem(this.dataPath, {
      uid: daemon.system.user.uid,
      gid: daemon.system.user.gid,
      denylist: () => this.config.egg.fileDenylist,
      quota: {
        remaining: async () => {
          const limit = this.config.build.diskSpace * 1024 * 1024;
          return limit <= 0 ? Infinity : Math.max(0, limit - (await this.diskUsage()));
        },
        add: (bytes) => {
          this.disk.bytes = Math.max(0, this.disk.bytes + bytes);
        },
      },
    });
  }

  /** Revoke console/transfer tokens these users already hold and close their sockets. */
  denyUsers(users: string[]) {
    const now = Date.now();
    for (const u of users) this.denyBefore.set(u, now);
    this.emit('deny', users);
  }

  /** Whether a token for `user` issued at `issuedAtSeconds` is still acceptable. */
  tokenAllowed(user: string, issuedAtSeconds: number | undefined) {
    const before = this.denyBefore.get(user);
    return before === undefined || (issuedAtSeconds ?? 0) * 1000 > before;
  }

  get uuid() {
    return this.config.uuid;
  }

  get dataPath() {
    return path.resolve(this.daemon.system.dataDirectory, this.uuid);
  }

  get consoleHistory(): readonly string[] {
    return this.history;
  }

  private get container() {
    return this.docker.getContainer(this.uuid);
  }

  async ensureDataDirectory() {
    await mkdir(this.dataPath, { recursive: true });
    await chownPath(this.dataPath, this.daemon.system.user.uid, this.daemon.system.user.gid);
  }

  private setState(state: ProcessState) {
    if (this.state === state) return;
    this.state = state;
    this.log.debug({ server: this.uuid, state }, 'state change');
    this.emit('state', state);
  }

  private message(text: string) {
    this.emit('message', text);
  }

  // --- Output ------------------------------------------------------------------------------------

  private handleOutput(chunk: Buffer) {
    const text = this.partial + this.decoder.write(chunk);
    const lines = text.split(/\r?\n/);
    this.partial = lines.pop() ?? '';
    for (const line of lines) this.pushLine(line);
  }

  private pushLine(line: string) {
    const now = Date.now();
    if (now - this.throttleWindow >= 1000) {
      if (this.linesThisSecond > MAX_LINES_PER_SECOND) {
        this.message(`Console output throttled: ${this.linesThisSecond - MAX_LINES_PER_SECOND} lines dropped.`);
      }
      this.throttleWindow = now;
      this.linesThisSecond = 0;
    }
    if (++this.linesThisSecond > MAX_LINES_PER_SECOND) return;

    this.history.push(line);
    if (this.history.length > CONSOLE_HISTORY) this.history.splice(0, this.history.length - CONSOLE_HISTORY);
    this.emit('console', line);

    if (this.state === 'starting' && this.matchesDone(line)) this.setState('running');
  }

  private matchesDone(line: string): boolean {
    const plain = line.replace(ANSI, '');
    return this.config.process.startup.done.some((d) => {
      if (d.startsWith('regex:')) {
        try {
          return new RegExp(d.slice(6)).test(plain);
        } catch {
          return false;
        }
      }
      return plain.includes(d);
    });
  }

  private async attach() {
    this.decoder = new StringDecoder('utf8');
    this.partial = '';
    const stream = (await this.container.attach({ stream: true, stdin: true, stdout: true, stderr: true, hijack: true })) as NodeJS.ReadWriteStream;
    stream.on('data', (chunk: Buffer) => this.handleOutput(chunk));
    stream.on('error', (err) => this.log.warn({ err, server: this.uuid }, 'console stream error'));
    this.stream = stream;
  }

  private detach() {
    if (this.partial) this.pushLine(this.partial);
    this.partial = '';
    this.stream?.removeAllListeners('data');
    (this.stream as unknown as { destroy?: () => void })?.destroy?.();
    this.stream = null;
  }

  // --- Stats -------------------------------------------------------------------------------------

  private async startStats() {
    this.stopStats();
    try {
      const stream = (await this.container.stats({ stream: true })) as unknown as NodeJS.ReadableStream;
      let buffer = '';
      stream.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        let nl: number;
        while ((nl = buffer.indexOf('\n')) !== -1) {
          const raw = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!raw) continue;
          try {
            const stats = JSON.parse(raw);
            const net = networkTotals(stats);
            this.usage = { cpu: cpuPercent(stats), memory: memoryUsage(stats), rx: net.rx, tx: net.tx };
            this.recordSample();
            this.emit('stats', this.resources());
          } catch {
            // Partial or malformed frame; the next one will do.
          }
        }
      });
      stream.on('error', () => undefined);
      this.statsStream = stream;
    } catch (err) {
      this.log.warn({ err, server: this.uuid }, 'could not start stats stream');
    }
  }

  private stopStats() {
    (this.statsStream as unknown as { destroy?: () => void })?.destroy?.();
    this.statsStream = null;
    this.usage = { cpu: 0, memory: 0, rx: 0, tx: 0 };
  }

  private recordSample() {
    const now = Date.now();
    const last = this.samples.at(-1);
    if (last && now - last.t < HISTORY_INTERVAL_MS) return;
    this.samples.push({ t: now, cpu: this.usage.cpu, memoryBytes: this.usage.memory, networkRxBytes: this.usage.rx, networkTxBytes: this.usage.tx });
    if (this.samples.length > HISTORY_LENGTH) this.samples.splice(0, this.samples.length - HISTORY_LENGTH);
  }

  /** Samples from the last hour; gaps mean the server was offline. */
  resourceHistory(): ResourceSample[] {
    const cutoff = Date.now() - HISTORY_INTERVAL_MS * HISTORY_LENGTH;
    return this.samples.filter((s) => s.t >= cutoff);
  }

  /** Disk usage, recalculated at most once a minute (walking big worlds is not free). */
  async diskUsage(force = false): Promise<number> {
    if (!force && Date.now() - this.disk.checkedAt < DISK_CHECK_INTERVAL_MS) return this.disk.bytes;
    this.disk.pending ??= directorySize(this.dataPath).then((bytes) => {
      this.disk = { bytes, checkedAt: Date.now(), pending: null };
      return bytes;
    });
    return this.disk.pending;
  }

  resources(): ServerResourceUsage {
    void this.diskUsage();
    const limit = this.config.build.memoryLimit * 1024 * 1024;
    return {
      state: this.state,
      cpu: this.usage.cpu,
      memoryBytes: this.usage.memory,
      memoryLimitBytes: limit,
      diskBytes: this.disk.bytes,
      networkRxBytes: this.usage.rx,
      networkTxBytes: this.usage.tx,
      uptimeMs: this.state === 'offline' || !this.startedAt ? 0 : Date.now() - this.startedAt,
    };
  }

  // --- Lifecycle ---------------------------------------------------------------------------------

  /** On daemon boot, pick up a container that kept running while the daemon was down. */
  async reattach() {
    try {
      const info = await this.container.inspect();
      if (!info.State.Running) return;
      const logs = (await this.container.logs({ stdout: true, stderr: true, tail: CONSOLE_HISTORY })) as unknown as Buffer;
      this.history = logs.toString('utf8').split(/\r?\n/).filter(Boolean).slice(-CONSOLE_HISTORY);
      await this.attach();
      this.startedAt = new Date(info.State.StartedAt).getTime();
      this.setState('running');
      void this.startStats();
      this.watchExit();
      this.log.info({ server: this.uuid }, 'reattached to running server');
    } catch (err) {
      if (!isNotFound(err)) this.log.warn({ err, server: this.uuid }, 'failed to reattach');
    }
  }

  /**
   * Write the egg's config-file replacements now (normally done on start), or a one-off set from
   * the panel, e.g. turning proxy forwarding off when a server leaves a network. Returns errors.
   */
  async applyConfigs(configs: ConfigFile[] = this.config.process.configs): Promise<string[]> {
    const errors: string[] = [];
    const written = await applyConfigFiles(this.dataPath, configs, this.daemon, (file, err) => {
      errors.push(`${file}: ${err.message}`);
      this.message(`Could not update ${file}: ${err.message}`);
    });
    for (const f of written) await chownPath(f, this.daemon.system.user.uid, this.daemon.system.user.gid);
    return errors;
  }

  /** Re-fetch configuration from the panel. Suspending a running server stops it. */
  async sync() {
    this.config = await this.panel.getServer(this.uuid);
    if (this.config.suspended && this.state !== 'offline') {
      this.message('This server has been suspended.');
      await this.kill();
    }
  }

  /** Run power actions one at a time; `kill` jumps the queue so a stuck stop can always be ended. */
  power(action: PowerAction): Promise<void> {
    if (action === 'kill') return this.kill();
    const run = this.powerQueue.then(() => {
      switch (action) {
        case 'start':
          return this.start();
        case 'stop':
          return this.stop();
        case 'restart':
          return this.restart();
      }
    });
    this.powerQueue = run.catch(() => undefined);
    return run;
  }

  private async start() {
    if (this.state !== 'offline') throw new ServerError('The server is already running.');
    if (this.installing) throw new ServerError('The server is installing.');
    if (this.restoring) throw new ServerError('A backup is being restored.');
    if (this.config.suspended) throw new ServerError('This server is suspended.');

    this.setState('starting');
    try {
      await this.sync();
      if (this.config.suspended) throw new ServerError('This server is suspended.');

      if (this.config.build.diskSpace > 0) {
        const used = await this.diskUsage(true);
        if (used > this.config.build.diskSpace * 1024 * 1024) {
          throw new ServerError('Not enough disk space: the server is over its disk limit.');
        }
      }

      await this.ensureDataDirectory();
      await this.applyConfigs();

      this.message('Pulling Docker image...');
      await pullImage(this.docker, this.config.container.image, () => undefined);

      await this.removeContainer();
      await this.docker.createContainer(serverContainerSpec(this.config, this.daemon, this.dataPath));
      await this.attach();
      this.expectingExit = false;
      await this.container.start();
      this.startedAt = Date.now();
      this.message('Server started.');
      void this.startStats();
      this.watchExit();
      if (this.config.process.startup.done.length === 0) this.setState('running');
    } catch (err) {
      this.detach();
      this.setState('offline');
      this.message(`Failed to start: ${(err as Error).message}`);
      throw err instanceof ServerError ? err : new ServerError((err as Error).message, 500);
    }
  }

  private async stop() {
    if (this.state === 'offline' || this.state === 'stopping') return;
    this.setState('stopping');
    this.expectingExit = true;
    const { type, value } = this.config.process.stop;
    if (type === 'signal') {
      await this.container.kill({ signal: value }).catch(() => undefined);
    } else if (this.stream) {
      this.stream.write(`${value}\n`);
    } else {
      await this.container.stop({ t: this.daemon.system.stopTimeout }).catch(() => undefined);
    }
  }

  async kill() {
    if (this.state === 'offline') return;
    this.expectingExit = true;
    this.setState('stopping');
    try {
      await this.container.kill({ signal: 'SIGKILL' });
    } catch (err) {
      // 409: container not running any more, 404: already gone.
      const code = (err as { statusCode?: number }).statusCode;
      if (code !== 409 && code !== 404) throw err;
      this.setState('offline');
    }
  }

  private async restart() {
    if (this.state !== 'offline') {
      await this.stop();
      if (!(await this.waitForOffline(this.daemon.system.stopTimeout * 1000))) {
        this.message('Server did not stop in time; killing it.');
        await this.kill();
        await this.waitForOffline(15_000);
      }
    }
    await this.start();
  }

  waitForOffline(timeoutMs: number): Promise<boolean> {
    if (this.state === 'offline') return Promise.resolve(true);
    return new Promise((resolve) => {
      const onState = (s: ProcessState) => {
        if (s !== 'offline') return;
        clearTimeout(timer);
        this.off('state', onState);
        resolve(true);
      };
      const timer = setTimeout(() => {
        this.off('state', onState);
        resolve(false);
      }, timeoutMs);
      this.on('state', onState);
    });
  }

  private watchExit() {
    this.container
      .wait()
      .then((result: { StatusCode: number }) => this.onExit(result.StatusCode))
      .catch((err) => {
        this.log.warn({ err, server: this.uuid }, 'lost track of container');
        this.onExit(-1);
      });
  }

  private onExit(code: number) {
    if (this.state === 'offline') return;
    const expected = this.expectingExit;
    this.detach();
    this.stopStats();
    this.startedAt = 0;
    this.setState('offline');

    if (expected) {
      this.message('Server stopped.');
      return;
    }
    this.message(`Server crashed (exit code ${code}).`);
    const cooldown = this.daemon.system.crashRestartCooldown * 1000;
    if (cooldown <= 0 || this.config.suspended) return;
    if (Date.now() - this.lastCrashAt < cooldown) {
      this.message(`Not restarting: it crashed again within ${this.daemon.system.crashRestartCooldown} seconds.`);
      return;
    }
    this.lastCrashAt = Date.now();
    this.message('Restarting after crash...');
    setTimeout(() => void this.power('start').catch(() => undefined), 2_000);
  }

  sendCommand(command: string) {
    if (!this.stream || (this.state !== 'running' && this.state !== 'starting')) {
      throw new ServerError('The server is not running.');
    }
    this.stream.write(`${command}\n`);
  }

  private async removeContainer(name = this.uuid) {
    try {
      await this.docker.getContainer(name).remove({ force: true, v: true });
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
  }

  // --- Installation ------------------------------------------------------------------------------

  /** Run the egg's install script in a throwaway container, then report the result to the panel. */
  async install(reinstall: boolean): Promise<boolean> {
    if (this.installing) throw new ServerError('An installation is already running.');
    if (this.restoring) throw new ServerError('A backup is being restored.');
    if (this.state !== 'offline') {
      await this.kill();
      await this.waitForOffline(15_000);
    }
    this.installing = true;
    this.emit('install-started');

    const logFile = path.join(this.daemon.system.logDirectory, 'install', `${this.uuid}.log`);
    const scriptDir = path.resolve(this.daemon.system.tmpDirectory, this.uuid);
    const out = (line: string) => {
      this.emit('install', line);
      void appendFile(logFile, line + '\n').catch(() => undefined);
    };

    let successful = false;
    try {
      await mkdir(path.dirname(logFile), { recursive: true });
      await writeFile(logFile, `Glacier Panel installation log for ${this.uuid} (${new Date().toISOString()})\n`);
      this.config = await this.panel.getServer(this.uuid);
      const script = await this.panel.getInstallScript(this.uuid);
      await this.ensureDataDirectory();
      await rm(scriptDir, { recursive: true, force: true });
      await mkdir(scriptDir, { recursive: true });
      await writeFile(path.join(scriptDir, 'install.sh'), script.script.replace(/\r\n/g, '\n'), { mode: 0o755 });

      out(`Pulling installer image ${script.containerImage}...`);
      await pullImage(this.docker, script.containerImage, out);

      const name = `${this.uuid}_installer`;
      await this.removeContainer(name);
      const container = await this.docker.createContainer(
        installContainerSpec(this.config, this.daemon, { image: script.containerImage, entrypoint: script.entrypoint }, this.dataPath, scriptDir),
      );
      const stream = (await container.attach({ stream: true, stdout: true, stderr: true })) as NodeJS.ReadableStream;
      const decoder = new StringDecoder('utf8');
      let partial = '';
      stream.on('data', (chunk: Buffer) => {
        const lines = (partial + decoder.write(chunk)).split(/\r?\n/);
        partial = lines.pop() ?? '';
        lines.forEach(out);
      });

      out('Running installation script...');
      await container.start();
      const { StatusCode } = (await container.wait()) as { StatusCode: number };
      if (partial) out(partial);
      await container.remove({ force: true }).catch(() => undefined);

      successful = StatusCode === 0;
      out(successful ? 'Installation completed successfully.' : `Installation failed with exit code ${StatusCode}.`);
      await chownRecursive(this.dataPath, this.daemon.system.user.uid, this.daemon.system.user.gid);
    } catch (err) {
      out(`Installation failed: ${(err as Error).message}`);
      this.log.error({ err, server: this.uuid }, 'installation failed');
    } finally {
      this.installing = false;
      await rm(scriptDir, { recursive: true, force: true }).catch(() => undefined);
    }

    try {
      await this.panel.reportInstall(this.uuid, { successful, reinstall });
    } catch (err) {
      this.log.error({ err, server: this.uuid }, 'failed to report install status to the panel');
    }
    this.emit('install-completed', successful);
    return successful;
  }

  // --- Backups ----------------------------------------------------------------------------------

  backupPath(uuid: string) {
    return path.resolve(this.daemon.system.backupDirectory, `${uuid}.tar.gz`);
  }

  /** Archive the data directory, then report checksum and size to the panel. Runs in the background. */
  async backup(uuid: string, ignore: string[]): Promise<void> {
    const target = this.backupPath(uuid);
    let completion = { successful: false, checksum: null as string | null, bytes: 0 };
    try {
      await mkdir(path.dirname(target), { recursive: true });
      await createTarGz(this.dataPath, ['.'], target, ignore);
      const hash = createHash('sha256');
      await pipeline(createReadStream(target), hash);
      completion = { successful: true, checksum: hash.digest('hex'), bytes: (await stat(target)).size };
    } catch (err) {
      this.log.error({ err, server: this.uuid, backup: uuid }, 'backup failed');
      await rm(target, { force: true }).catch(() => undefined);
    }
    try {
      await this.panel.reportBackup(uuid, completion);
    } catch (err) {
      this.log.error({ err, backup: uuid }, 'failed to report backup to the panel');
    }
    this.emit('backup-completed', uuid, completion.successful);
  }

  /** Stop the server and restore a local backup over (or instead of) the current files. */
  async restore(uuid: string, truncate: boolean): Promise<void> {
    if (this.installing) throw new ServerError('The server is installing.');
    if (this.restoring) throw new ServerError('A backup is already being restored.');
    const archive = this.backupPath(uuid);
    await stat(archive).catch(() => {
      throw new ServerError('That backup is not on this node.', 404);
    });
    this.restoring = true;
    let successful = false;
    try {
      if (this.state !== 'offline') {
        this.message('Stopping the server to restore a backup...');
        await this.kill();
        await this.waitForOffline(15_000);
      }
      this.message('Restoring backup...');
      if (truncate) {
        for (const entry of await readdir(this.dataPath)) await rm(path.join(this.dataPath, entry), { recursive: true, force: true });
      }
      // The backup fit before, so restore it in full rather than stopping halfway at the limit.
      await extractArchive(archive, this.dataPath, { remaining: async () => Infinity, add: () => undefined });
      await chownRecursive(this.dataPath, this.daemon.system.user.uid, this.daemon.system.user.gid);
      await this.diskUsage(true);
      successful = true;
      this.message('Backup restored.');
    } catch (err) {
      this.log.error({ err, server: this.uuid, backup: uuid }, 'restore failed');
      this.message(`Restoring the backup failed: ${(err as Error).message}`);
    } finally {
      this.restoring = false;
    }
    try {
      await this.panel.reportRestore(uuid, successful);
    } catch (err) {
      this.log.error({ err, backup: uuid }, 'failed to report restore to the panel');
    }
    this.emit('restore-completed', uuid, successful);
  }

  /** Remove the container and every file belonging to this server. */
  async destroy() {
    await this.kill().catch(() => undefined);
    this.stopStats();
    this.detach();
    await this.removeContainer();
    await this.removeContainer(`${this.uuid}_installer`);
    await rm(this.dataPath, { recursive: true, force: true });
    this.removeAllListeners();
  }
}
