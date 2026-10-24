# Glacier Panel

A free, self-hosted game server panel in the spirit of Pterodactyl: install it on your own VPS or dedicated server and run game servers for yourself, your friends or your community. Written from scratch in TypeScript, with its own node daemon (`glacierd`), deep admin customization, power-user server tools and a one-line installer. Pterodactyl eggs (PTDL v1/v2) import as-is, and the bundled eggs export back to PTDL_v2.

```
apps/api       Panel API: Fastify 5, Prisma (PostgreSQL), Zod
apps/web       Panel UI: React 19, Vite, Tailwind 4, TanStack Query, xterm.js
apps/daemon    glacierd: Fastify + websockets, dockerode
packages/shared  Settings schema, permissions, feature flags, panel<->daemon protocol
packages/eggs    PTDL egg parser/exporter, variable rule validation, bundled eggs
```

## Status

| Milestone | State |
| --- | --- |
| M0 Scaffold (workspaces, TS, Vitest, dev services, Prisma schema) | ✅ |
| M1 Identity & shell (sessions, argon2id, CSRF/origin checks, rate limits, users, settings store, live theming, setup wizard) | ✅ |
| M2 Daemon core (pairing, Docker lifecycle, egg installs, power, console websocket, stats, crash restart, config-file rewriting) | ✅ code complete. Container paths still need a run on a Linux host with Docker (see below) |
| M3 File manager & editor, uploads/downloads, SFTP, backups & restore, MySQL databases, schedules, subusers, startup editor, ports | ✅ (container-backed paths need a Docker host, see below) |
| M4 Landing page builder, navigation editor, custom pages, SMTP + editable email templates, password reset, text overrides, sign-in & dashboard layouts | ✅ |
| M5 Two-factor (TOTP + recovery codes, optional enforcement), passkeys, Discord/Google/GitHub login, scoped API keys, signed + Discord webhooks, announcements, admin IP allowlist | ✅ |
| M6 Plugin & mod installer (Modrinth, Hangar, CurseForge), version switcher (Paper/Purpur/Vanilla/Fabric), player manager, resource history graphs, file search, Cloudflare subdomains + SRV, server templates | ✅ |
| M7 Smart installer (`installer/install.sh`) with `glacier update` ✅ · Pterodactyl migration ⏳ next | 🚧 |

## Installing on a server

On a fresh Ubuntu 22.04/24.04 or Debian 12 server, with your domain pointing at it:

```bash
curl -fsSL https://raw.githubusercontent.com/BimuluDevelopment/glacier/master/installer/install.sh | sudo bash
```

See **[docs/install.md](docs/install.md)** for the full install guide: the panel and a node on one machine, adding more nodes, and optional extras (email, social sign-in, CurseForge, Cloudflare subdomains, MySQL). Templates for nginx, systemd and the database live in [deploy/](deploy/).

## Development

Requirements: Node 22+, Docker (for Postgres/Redis and for running game servers through glacierd).

```bash
npm install
npm run services:up                     # postgres, redis, mailpit, minio
cp apps/api/.env.example apps/api/.env  # then set APP_KEY
npm run db:deploy                       # apply migrations
npm run dev                             # API on :3000, web on :5173 (proxies /api)
```

Open http://localhost:5173. The setup wizard creates the first admin and installs the bundled eggs (Paper, Vanilla, Node.js, Python).

To run a node locally: create a node in **Admin → Nodes** with FQDN `localhost`, scheme `http` and daemon port `8080`, and add a few allocations. Then:

```bash
cd apps/daemon
npx tsx src/index.ts pair --panel http://localhost:5173 --token <token from the panel> --config ./config.yml
npm run dev
```

Other commands: `npm test`, `npm run typecheck`, `npm run build`, `npm run lint`.

## How the pieces talk

- **Panel → daemon**: HTTP with `Authorization: Bearer <node secret>`.
- **Daemon → panel**: `/api/remote/*` with `Bearer <node uuid>.<node secret>`. The secret is issued once, when a one-time pairing token is exchanged (`glacierd pair`). The panel stores it AES-256-GCM-encrypted under `APP_KEY`.
- **Browser → daemon console**: a websocket straight to the node, authenticated with a 10-minute HS256 JWT. The panel signs it with the node secret and it carries the user's server permissions. The client re-authenticates before expiry.
- **Settings**: sections of typed JSON (`packages/shared/src/settings.ts`), merged over defaults when read, so new settings never need a migration. The web app turns the theme into CSS variables at runtime.
