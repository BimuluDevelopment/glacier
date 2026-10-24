import Docker from 'dockerode';
import type { DaemonConfig } from '../config';
import type { Logger } from '../logger';

export function createDocker(config: DaemonConfig): Docker {
  return config.docker.socket ? new Docker({ socketPath: config.docker.socket }) : new Docker();
}

export function isNotFound(err: unknown): boolean {
  return (err as { statusCode?: number })?.statusCode === 404;
}

/** Create the bridge network servers attach to, if it does not exist yet. */
export async function ensureNetwork(docker: Docker, config: DaemonConfig, log: Logger) {
  const { name, interface: gateway, subnet } = config.docker.network;
  const networks = await docker.listNetworks({ filters: { name: [name] } });
  if (networks.some((n) => n.Name === name)) return;
  log.info({ name, subnet }, 'creating docker network');
  try {
    await docker.createNetwork({
      Name: name,
      Driver: 'bridge',
      CheckDuplicate: true,
      IPAM: { Config: [{ Subnet: subnet, Gateway: gateway }] },
      Options: {
        'com.docker.network.bridge.name': name,
        'com.docker.network.bridge.enable_icc': 'true',
        'com.docker.network.bridge.enable_ip_masquerade': 'true',
        'com.docker.network.driver.mtu': '1500',
      },
    });
  } catch (err) {
    if (/overlap/i.test((err as Error).message)) {
      throw new Error(
        `Docker network ${subnet} overlaps an existing network. Pick a free range in docker.network.subnet ` +
          `and docker.network.interface in the glacierd config (see "docker network inspect $(docker network ls -q)").`,
      );
    }
    throw err;
  }
}

/**
 * Pull an image, reporting progress lines. If the pull fails but the image exists locally
 * (registry down, offline node), carry on with the local copy.
 */
export async function pullImage(docker: Docker, image: string, onProgress: (line: string) => void): Promise<void> {
  try {
    const stream = await docker.pull(image);
    await new Promise<void>((resolve, reject) => {
      docker.modem.followProgress(
        stream,
        (err) => (err ? reject(err) : resolve()),
        (event: { status?: string; progress?: string; id?: string }) => {
          if (event.status && !event.progress) onProgress(`${event.id ? `${event.id}: ` : ''}${event.status}`);
        },
      );
    });
  } catch (err) {
    try {
      await docker.getImage(image).inspect();
      onProgress(`Could not pull ${image} (${(err as Error).message}); using the local copy.`);
    } catch {
      throw new Error(`Failed to pull image ${image}: ${(err as Error).message}`);
    }
  }
}
