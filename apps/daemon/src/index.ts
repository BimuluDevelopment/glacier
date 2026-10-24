import { parseArgs } from 'node:util';
import { existsSync } from 'node:fs';
import type { PairResponse } from '@glacier/shared';
import { DEFAULT_CONFIG_PATH, loadConfig, writeConfig } from './config';
import { createDocker, ensureNetwork } from './docker/docker';
import { createHttp, registerRoutes, VERSION } from './http/app';
import { PanelClient } from './panel';
import { ServerManager } from './server/manager';
import { startSftpServer } from './sftp/server';

const HELP = `glacierd ${VERSION} — Glacier Panel node daemon

Usage:
  glacierd [--config <path>]                       Run the daemon
  glacierd pair --panel <url> --token <token>      Pair this machine with a panel node
  glacierd diagnostics [--config <path>]           Check Docker and panel connectivity
  glacierd --version

Options:
  --config <path>   Config file (default ${DEFAULT_CONFIG_PATH})
  --force           With "pair": overwrite an existing config
`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    config: { type: 'string', default: DEFAULT_CONFIG_PATH },
    panel: { type: 'string' },
    token: { type: 'string' },
    force: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
    version: { type: 'boolean', short: 'v', default: false },
  },
});

const command = positionals[0] ?? 'run';

async function pair() {
  if (!values.panel || !values.token) throw new Error('Usage: glacierd pair --panel <url> --token <token>');
  if (existsSync(values.config!) && !values.force) {
    throw new Error(`${values.config} already exists. Pass --force to replace it (the old pairing stops working).`);
  }
  const panel = values.panel.replace(/\/$/, '');
  const res = await fetch(`${panel}/api/remote/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: values.token }),
    signal: AbortSignal.timeout(15_000),
  }).catch((err) => {
    throw new Error(`Could not reach the panel at ${panel}: ${err.message}`);
  });
  const data = (await res.json().catch(() => ({}))) as PairResponse & { message?: string };
  if (!res.ok) throw new Error(data.message ?? `Panel returned HTTP ${res.status}`);

  await writeConfig(values.config!, {
    uuid: data.nodeUuid,
    token: data.secret,
    panel: { url: data.panelUrl },
    api: { port: data.daemonPort, uploadLimit: data.uploadSize, fqdn: data.fqdn },
    sftp: { port: data.sftpPort },
    system: { dataDirectory: data.dataDirectory },
  });
  console.log(`Paired with ${data.panelUrl} as node ${data.nodeUuid}.`);
  console.log(`Config written to ${values.config}.`);
  if (data.panelUrl.startsWith('https://')) {
    console.log(`\nThe panel uses HTTPS, so browsers need this daemon on HTTPS too.`);
    console.log(`Set api.ssl in the config with a certificate for ${data.fqdn} (the installer does this with Let's Encrypt).`);
  }
  console.log(`\nStart the daemon with: systemctl enable --now glacierd   (or run "glacierd")`);
}

async function diagnostics() {
  const config = await loadConfig(values.config!);
  const docker = createDocker(config);
  const check = async (label: string, fn: () => Promise<string>) => {
    try {
      console.log(`  ok    ${label}: ${await fn()}`);
    } catch (err) {
      console.log(`  FAIL  ${label}: ${(err as Error).message}`);
    }
  };
  console.log(`glacierd ${VERSION} diagnostics (${values.config})`);
  await check('Docker', async () => `v${(await docker.version()).Version}`);
  await check('Panel', async () => `${(await new PanelClient(config).listServers()).length} servers assigned`);
  await check('Data directory', async () => config.system.dataDirectory);
}

async function run() {
  const config = await loadConfig(values.config!);
  const docker = createDocker(config);
  const panel = new PanelClient(config);

  const app = await createHttp(config);
  const log = app.log;

  await docker.ping().catch((err) => {
    throw new Error(`Cannot talk to Docker (${err.message}). Is it installed and running?`);
  });
  await ensureNetwork(docker, config, log);

  const manager = new ServerManager(config, docker, panel, log);
  await registerRoutes(app, config, docker, manager);
  await manager.boot();

  await app.listen({ host: config.api.host, port: config.api.port });
  const sftp = config.sftp.enabled ? startSftpServer(config, manager, panel, log) : null;
  log.info(`glacierd ${VERSION} ready (node ${config.uuid})`);

  const shutdown = async () => {
    log.info('shutting down; game servers keep running');
    sftp?.close();
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

try {
  if (values.version) console.log(VERSION);
  else if (values.help) console.log(HELP);
  else if (command === 'pair') await pair();
  else if (command === 'diagnostics') await diagnostics();
  else if (command === 'run') await run();
  else {
    console.error(`Unknown command "${command}"\n\n${HELP}`);
    process.exit(1);
  }
} catch (err) {
  console.error(`glacierd: ${(err as Error).message}`);
  process.exit(1);
}
