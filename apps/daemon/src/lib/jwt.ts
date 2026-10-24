import { jwtVerify, type JWTPayload } from 'jose';
import { panelOrigin, type DaemonConfig } from '../config';

/** Verify a token the panel signed for this node (websocket or file transfer). */
export async function verifyPanelToken<T extends object>(token: string, config: DaemonConfig): Promise<T & JWTPayload> {
  const { payload } = await jwtVerify<T>(token, new TextEncoder().encode(config.token), {
    algorithms: ['HS256'],
    audience: config.uuid,
    issuer: panelOrigin(config),
  });
  return payload;
}
