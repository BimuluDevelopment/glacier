import type {
  BackupCompletion,
  InstallStatusReport,
  InstallationScript,
  ServerConfiguration,
  SftpAuthRequest,
  SftpAuthResponse,
} from '@glacier/shared';
import type { DaemonConfig } from './config';

export class PanelError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
  }
}

/** Client for the panel's /api/remote routes. */
export class PanelClient {
  constructor(private readonly config: DaemonConfig) {}

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.config.panel.url.replace(/\/$/, '')}/api/remote${path}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: {
          authorization: `Bearer ${this.config.uuid}.${this.config.token}`,
          accept: 'application/json',
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      throw new PanelError(`Panel at ${this.config.panel.url} is unreachable: ${(err as Error).message}`);
    }
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) throw new PanelError(data?.message ?? `Panel returned HTTP ${res.status}`, res.status);
    return data as T;
  }

  listServers() {
    return this.request<{ data: ServerConfiguration[] }>('GET', '/servers').then((r) => r.data);
  }

  getServer(uuid: string) {
    return this.request<ServerConfiguration>('GET', `/servers/${uuid}`);
  }

  getInstallScript(uuid: string) {
    return this.request<InstallationScript>('GET', `/servers/${uuid}/install`);
  }

  reportInstall(uuid: string, report: InstallStatusReport) {
    return this.request('POST', `/servers/${uuid}/install`, report);
  }

  resetInstallStates() {
    return this.request<{ reset: number }>('POST', '/servers/reset');
  }

  reportBackup(uuid: string, completion: BackupCompletion) {
    return this.request('POST', `/backups/${uuid}`, completion);
  }

  reportRestore(uuid: string, successful: boolean) {
    return this.request('POST', `/backups/${uuid}/restore`, { successful });
  }

  /** Check SFTP credentials. Throws PanelError (401/403) when they are wrong. */
  sftpAuth(req: SftpAuthRequest) {
    return this.request<SftpAuthResponse>('POST', '/sftp/auth', req);
  }
}
