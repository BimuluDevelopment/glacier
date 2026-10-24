import { describe, expect, it } from 'vitest';
import { requiredScope } from './auth';
import { eventMatches } from '../modules/webhooks/service';

describe('requiredScope', () => {
  it('maps routes to API key scopes', () => {
    expect(requiredScope('GET', '/api/client/servers')).toBe('client:read');
    expect(requiredScope('POST', '/api/client/servers/abc/power')).toBe('client:write');
    expect(requiredScope('GET', '/api/admin/users?page=2')).toBe('admin:read');
    expect(requiredScope('DELETE', '/api/admin/users/x')).toBe('admin:write');
    expect(requiredScope('GET', '/api/public/branding')).toBe('none');
  });

  it('keeps keys away from account and sign-in routes', () => {
    expect(requiredScope('POST', '/api/client/account/api-keys')).toBeNull();
    expect(requiredScope('PUT', '/api/client/account/password')).toBeNull();
    expect(requiredScope('POST', '/api/auth/logout')).toBeNull();
    expect(requiredScope('GET', '/api/remote/servers')).toBeNull();
  });
});

describe('eventMatches', () => {
  it('supports exact, prefix and catch-all patterns', () => {
    expect(eventMatches('*', 'server:power.start')).toBe(true);
    expect(eventMatches('server:power.*', 'server:power.kill')).toBe(true);
    expect(eventMatches('server:power.*', 'server:backup.completed')).toBe(false);
    expect(eventMatches('admin:*', 'admin:node.create')).toBe(true);
    expect(eventMatches('auth:login.failed', 'auth:login')).toBe(false);
  });
});
