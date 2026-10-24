import { useOutletContext } from 'react-router';
import { hasPermission, type ServerPermission } from '@glacier/shared';
import type { ClientServer } from '../../lib/types';

export interface ServerContext {
  server: ClientServer;
  can: (permission: ServerPermission) => boolean;
  /** Base API path, e.g. "/client/servers/abcd1234". */
  base: string;
}

export function makeServerContext(server: ClientServer): ServerContext {
  return {
    server,
    can: (p) => hasPermission(server.permissions, p),
    base: `/client/servers/${server.id}`,
  };
}

export function useServer() {
  return useOutletContext<ServerContext>();
}
