import type Docker from 'dockerode';
import type { DaemonConfig } from '../config';
import type { Logger } from '../logger';
import type { PanelClient } from '../panel';
import { ServerError, ServerInstance } from './server';

export class ServerManager {
  private readonly servers = new Map<string, ServerInstance>();

  constructor(
    private readonly config: DaemonConfig,
    private readonly docker: Docker,
    private readonly panel: PanelClient,
    private readonly log: Logger,
  ) {}

  get size() {
    return this.servers.size;
  }

  all() {
    return [...this.servers.values()];
  }

  get(uuid: string): ServerInstance {
    const server = this.servers.get(uuid);
    if (!server) throw new ServerError('Server not found on this node.', 404);
    return server;
  }

  find(uuid: string): ServerInstance | undefined {
    return this.servers.get(uuid);
  }

  private instance(config: Awaited<ReturnType<PanelClient['getServer']>>) {
    return new ServerInstance(config, this.config, this.docker, this.panel, this.log);
  }

  /** Load every server assigned to this node and reattach to the ones still running. */
  async boot() {
    const { reset } = await this.panel.resetInstallStates();
    if (reset) this.log.warn({ count: reset }, 'marked interrupted installations as failed');
    const configs = await this.panel.listServers();
    for (const cfg of configs) {
      const server = this.instance(cfg);
      this.servers.set(cfg.uuid, server);
      try {
        await server.ensureDataDirectory();
        await server.reattach();
      } catch (err) {
        this.log.error({ err, server: cfg.uuid }, 'failed to load server');
      }
    }
    this.log.info({ count: configs.length }, 'servers loaded');
  }

  /** Called when the panel creates a server: fetch its config and run the installer in the background. */
  async create(uuid: string, startOnCompletion: boolean) {
    if (this.servers.has(uuid)) throw new ServerError('That server already exists on this node.');
    const server = this.instance(await this.panel.getServer(uuid));
    this.servers.set(uuid, server);
    await server.ensureDataDirectory();
    void server
      .install(false)
      .then(async (ok) => {
        if (ok && startOnCompletion) await server.power('start');
      })
      .catch((err) => this.log.error({ err, server: uuid }, 'post-install start failed'));
    return server;
  }

  async remove(uuid: string) {
    const server = this.get(uuid);
    await server.destroy();
    this.servers.delete(uuid);
  }
}
