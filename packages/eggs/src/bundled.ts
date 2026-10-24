import type { PtdlEgg } from './egg';

/**
 * Eggs seeded on first install. They are plain PTDL_v2 so they round-trip through Pterodactyl.
 * Scripts use `$VAR` (not `${VAR}`) so they can live in template literals.
 */

const paper: PtdlEgg = {
  meta: { version: 'PTDL_v2' },
  uuid: '5a1b0f2e-6c0e-4a43-9a8d-2f1c7b3e9d01',
  name: 'Paper',
  author: 'eggs@glacier.gg',
  description: 'High-performance Minecraft: Java Edition server with plugin support (Bukkit/Spigot/Paper).',
  features: ['eula', 'java_version', 'pid_limit'],
  docker_images: {
    'Java 25': 'ghcr.io/pterodactyl/yolks:java_25',
    'Java 21': 'ghcr.io/pterodactyl/yolks:java_21',
    'Java 17': 'ghcr.io/pterodactyl/yolks:java_17',
  },
  file_denylist: [],
  startup: 'java -Xms128M -XX:MaxRAMPercentage=95.0 -Dterminal.jline=false -Dterminal.ansi=true -jar {{SERVER_JARFILE}}',
  config: {
    files: JSON.stringify({
      'server.properties': {
        parser: 'properties',
        find: { 'server-ip': '0.0.0.0', 'server-port': '{{server.build.default.port}}', 'query.port': '{{server.build.default.port}}' },
      },
      'eula.txt': { parser: 'properties', find: { eula: '{{server.build.env.MINECRAFT_EULA}}' } },
    }),
    startup: JSON.stringify({ done: ')! For help, type ' }),
    logs: '{}',
    stop: 'stop',
  },
  scripts: {
    installation: {
      container: 'ghcr.io/pterodactyl/installers:alpine',
      entrypoint: 'ash',
      script: `#!/bin/ash
# Paper installation script: downloads a build from PaperMC's Fill API.
set -e
cd /mnt/server
API=https://fill.papermc.io/v3/projects/paper

if [ -z "$MINECRAFT_VERSION" ] || [ "$MINECRAFT_VERSION" = "latest" ]; then
  MINECRAFT_VERSION=$(curl -fsSL "$API" | jq -r '[.versions[][] | select(test("^[0-9]+(\\\\.[0-9]+)*$"))][0]')
fi

if [ -z "$BUILD_NUMBER" ] || [ "$BUILD_NUMBER" = "latest" ]; then
  BUILD_URL="$API/versions/$MINECRAFT_VERSION/builds/latest"
else
  BUILD_URL="$API/versions/$MINECRAFT_VERSION/builds/$BUILD_NUMBER"
fi

echo "Installing Paper $MINECRAFT_VERSION ($BUILD_NUMBER)"
DOWNLOAD_URL=$(curl -fsSL "$BUILD_URL" | jq -r '.downloads."server:default".url')
if [ -z "$DOWNLOAD_URL" ] || [ "$DOWNLOAD_URL" = "null" ]; then
  echo "No Paper build found for $MINECRAFT_VERSION"
  exit 1
fi

if [ -f "$SERVER_JARFILE" ]; then mv "$SERVER_JARFILE" "$SERVER_JARFILE.old"; fi
curl -fsSL -o "$SERVER_JARFILE" "$DOWNLOAD_URL"

if [ ! -f server.properties ]; then
  printf 'server-ip=0.0.0.0\\nserver-port=%s\\nquery.port=%s\\n' "$SERVER_PORT" "$SERVER_PORT" > server.properties
fi
echo "Paper installed."
`,
    },
  },
  variables: [
    {
      name: 'Minecraft Version',
      description: 'Version to install, e.g. 1.21.4. "latest" picks the newest stable release.',
      env_variable: 'MINECRAFT_VERSION',
      default_value: 'latest',
      user_viewable: true,
      user_editable: true,
      rules: 'nullable|string|max:32',
    },
    {
      name: 'Build Number',
      description: 'Paper build to install. "latest" picks the newest build.',
      env_variable: 'BUILD_NUMBER',
      default_value: 'latest',
      user_viewable: true,
      user_editable: true,
      rules: 'required|string|max:20',
    },
    {
      name: 'Server Jar File',
      description: 'Name of the jar the server runs.',
      env_variable: 'SERVER_JARFILE',
      default_value: 'server.jar',
      user_viewable: true,
      user_editable: true,
      rules: 'required|regex:/^([\\w\\d._-]+)(\\.jar)$/',
    },
    {
      name: 'Accept Minecraft EULA',
      description: 'Set to true to accept https://aka.ms/MinecraftEULA. The server will not start until you do.',
      env_variable: 'MINECRAFT_EULA',
      default_value: 'false',
      user_viewable: true,
      user_editable: true,
      rules: 'required|in:true,false',
    },
  ],
};

const vanilla: PtdlEgg = {
  ...paper,
  uuid: '5a1b0f2e-6c0e-4a43-9a8d-2f1c7b3e9d02',
  name: 'Vanilla Minecraft',
  description: 'The official Minecraft: Java Edition server from Mojang.',
  scripts: {
    installation: {
      container: 'ghcr.io/pterodactyl/installers:alpine',
      entrypoint: 'ash',
      script: `#!/bin/ash
# Vanilla Minecraft installation script: downloads the server jar from Mojang.
set -e
cd /mnt/server
MANIFEST=https://piston-meta.mojang.com/mc/game/version_manifest_v2.json

if [ -z "$MINECRAFT_VERSION" ] || [ "$MINECRAFT_VERSION" = "latest" ]; then
  MINECRAFT_VERSION=$(curl -fsSL "$MANIFEST" | jq -r '.latest.release')
fi
echo "Installing Minecraft $MINECRAFT_VERSION"
META_URL=$(curl -fsSL "$MANIFEST" | jq -r --arg v "$MINECRAFT_VERSION" '.versions[] | select(.id == $v) | .url')
if [ -z "$META_URL" ]; then echo "Unknown version $MINECRAFT_VERSION"; exit 1; fi
DOWNLOAD_URL=$(curl -fsSL "$META_URL" | jq -r '.downloads.server.url')
curl -fsSL -o "$SERVER_JARFILE" "$DOWNLOAD_URL"

if [ ! -f server.properties ]; then
  printf 'server-ip=0.0.0.0\\nserver-port=%s\\nquery.port=%s\\n' "$SERVER_PORT" "$SERVER_PORT" > server.properties
fi
echo "Minecraft installed."
`,
    },
  },
  variables: (paper.variables ?? []).filter((v) => v.env_variable !== 'BUILD_NUMBER'),
};

const purpur: PtdlEgg = {
  ...paper,
  uuid: '5a1b0f2e-6c0e-4a43-9a8d-2f1c7b3e9d03',
  name: 'Purpur',
  description: 'A Paper fork with extra gameplay options. Runs Paper, Spigot and Bukkit plugins.',
  scripts: {
    installation: {
      container: 'ghcr.io/pterodactyl/installers:alpine',
      entrypoint: 'ash',
      script: `#!/bin/ash
# Purpur installation script: downloads a build from the Purpur API.
set -e
cd /mnt/server
API=https://api.purpurmc.org/v2/purpur

if [ -z "$MINECRAFT_VERSION" ] || [ "$MINECRAFT_VERSION" = "latest" ]; then
  MINECRAFT_VERSION=$(curl -fsSL "$API" | jq -r '.metadata.current')
fi
if [ -z "$BUILD_NUMBER" ] || [ "$BUILD_NUMBER" = "latest" ]; then BUILD_NUMBER=latest; fi

echo "Installing Purpur $MINECRAFT_VERSION ($BUILD_NUMBER)"
if [ -f "$SERVER_JARFILE" ]; then mv "$SERVER_JARFILE" "$SERVER_JARFILE.old"; fi
curl -fsSL -o "$SERVER_JARFILE" "$API/$MINECRAFT_VERSION/$BUILD_NUMBER/download"

if [ ! -f server.properties ]; then
  printf 'server-ip=0.0.0.0\\nserver-port=%s\\nquery.port=%s\\n' "$SERVER_PORT" "$SERVER_PORT" > server.properties
fi
echo "Purpur installed."
`,
    },
  },
};

const fabric: PtdlEgg = {
  ...paper,
  uuid: '5a1b0f2e-6c0e-4a43-9a8d-2f1c7b3e9d04',
  name: 'Fabric',
  description: 'Lightweight Minecraft mod loader. Put Fabric mods (and Fabric API) in mods/.',
  scripts: {
    installation: {
      container: 'ghcr.io/pterodactyl/installers:alpine',
      entrypoint: 'ash',
      script: `#!/bin/ash
# Fabric installation script: downloads Fabric's server launcher, which fetches Minecraft on first start.
set -e
cd /mnt/server
META=https://meta.fabricmc.net/v2/versions

if [ -z "$MINECRAFT_VERSION" ] || [ "$MINECRAFT_VERSION" = "latest" ]; then
  MINECRAFT_VERSION=$(curl -fsSL "$META/game" | jq -r '[.[] | select(.stable)][0].version')
fi
if [ -z "$LOADER_VERSION" ] || [ "$LOADER_VERSION" = "latest" ]; then
  LOADER_VERSION=$(curl -fsSL "$META/loader" | jq -r '[.[] | select(.stable)][0].version')
fi
INSTALLER_VERSION=$(curl -fsSL "$META/installer" | jq -r '[.[] | select(.stable)][0].version')

echo "Installing Fabric loader $LOADER_VERSION for Minecraft $MINECRAFT_VERSION"
if [ -f "$SERVER_JARFILE" ]; then mv "$SERVER_JARFILE" "$SERVER_JARFILE.old"; fi
curl -fsSL -o "$SERVER_JARFILE" "$META/loader/$MINECRAFT_VERSION/$LOADER_VERSION/$INSTALLER_VERSION/server/jar"
mkdir -p mods

if [ ! -f server.properties ]; then
  printf 'server-ip=0.0.0.0\\nserver-port=%s\\nquery.port=%s\\n' "$SERVER_PORT" "$SERVER_PORT" > server.properties
fi
echo "Fabric installed. Add mods from the panel's Plugins & mods tab."
`,
    },
  },
  variables: [
    ...(paper.variables ?? []).filter((v) => v.env_variable !== 'BUILD_NUMBER'),
    {
      name: 'Fabric Loader Version',
      description: 'Fabric loader to install. "latest" picks the newest stable loader.',
      env_variable: 'LOADER_VERSION',
      default_value: 'latest',
      user_viewable: true,
      user_editable: true,
      rules: 'required|string|max:20',
    },
  ],
};

const PROXY_IMAGES = {
  'Java 21': 'ghcr.io/pterodactyl/yolks:java_21',
  'Java 17': 'ghcr.io/pterodactyl/yolks:java_17',
};
const PROXY_STARTUP =
  'java -Xms128M -XX:MaxRAMPercentage=95.0 -XX:+UseG1GC -XX:G1HeapRegionSize=4M -XX:+UnlockExperimentalVMOptions -XX:+ParallelRefProcEnabled -XX:+AlwaysPreTouch -jar {{SERVER_JARFILE}}';

const velocity: PtdlEgg = {
  meta: { version: 'PTDL_v2' },
  uuid: '5a1b0f2e-6c0e-4a43-9a8d-2f1c7b3e9d20',
  name: 'Velocity',
  author: 'eggs@glacier.gg',
  description: 'Modern, fast Minecraft proxy from PaperMC. Link Paper servers behind it from the Proxy tab.',
  features: ['java_version', 'pid_limit'],
  docker_images: PROXY_IMAGES,
  file_denylist: [],
  startup: PROXY_STARTUP,
  config: {
    files: JSON.stringify({
      'velocity.toml': { parser: 'file', find: { 'bind = ': 'bind = "0.0.0.0:{{server.build.default.port}}"' } },
    }),
    startup: JSON.stringify({ done: 'Done (' }),
    logs: '{}',
    stop: 'end',
  },
  scripts: {
    installation: {
      container: 'ghcr.io/pterodactyl/installers:alpine',
      entrypoint: 'ash',
      script: `#!/bin/ash
# Velocity installation script: downloads a build from PaperMC's Fill API.
set -e
cd /mnt/server
API=https://fill.papermc.io/v3/projects/velocity

if [ -z "$VELOCITY_VERSION" ] || [ "$VELOCITY_VERSION" = "latest" ]; then
  VELOCITY_VERSION=$(curl -fsSL "$API" | jq -r '[.versions[][]][0]')
fi
echo "Installing Velocity $VELOCITY_VERSION"
DOWNLOAD_URL=$(curl -fsSL "$API/versions/$VELOCITY_VERSION/builds/latest" | jq -r '.downloads."server:default".url')
if [ -z "$DOWNLOAD_URL" ] || [ "$DOWNLOAD_URL" = "null" ]; then
  echo "No Velocity build found for $VELOCITY_VERSION"
  exit 1
fi
if [ -f "$SERVER_JARFILE" ]; then mv "$SERVER_JARFILE" "$SERVER_JARFILE.old"; fi
curl -fsSL -o "$SERVER_JARFILE" "$DOWNLOAD_URL"

# A complete config before the first start, so the panel can manage its server list right away.
if [ ! -f velocity.toml ]; then
  cat > velocity.toml <<'EOF'
# Velocity configuration. The server list is managed from the panel's Proxy tab.
config-version = "2.7"
bind = "0.0.0.0:25565"
motd = "<#09add3>A Velocity Server"
show-max-players = 500
online-mode = true
force-key-authentication = true
prevent-client-proxy-connections = false
player-info-forwarding-mode = "NONE"
forwarding-secret-file = "forwarding.secret"
announce-forge = false
kick-existing-players = false
ping-passthrough = "DISABLED"
sample-players-in-ping = false
enable-player-address-logging = true

[servers]
try = []

[forced-hosts]

[advanced]
compression-threshold = 256
compression-level = -1
login-ratelimit = 3000
connection-timeout = 5000
read-timeout = 30000
haproxy-protocol = false
tcp-fast-open = false
bungee-plugin-message-channel = true
show-ping-requests = false
failover-on-unexpected-server-disconnect = true
announce-proxy-commands = true
log-command-executions = false
log-player-connections = true
accepts-transfers = false

[query]
enabled = false
port = 25565
map = "Velocity"
show-plugins = false
EOF
  sed -i "s/^bind = .*/bind = \\"0.0.0.0:$SERVER_PORT\\"/" velocity.toml
fi
echo "Velocity installed."
`,
    },
  },
  variables: [
    {
      name: 'Velocity Version',
      description: 'Version to install, e.g. 3.4.0-SNAPSHOT. "latest" picks the newest.',
      env_variable: 'VELOCITY_VERSION',
      default_value: 'latest',
      user_viewable: true,
      user_editable: true,
      rules: 'required|string|max:32',
    },
    {
      name: 'Server Jar File',
      description: 'Name of the jar the proxy runs.',
      env_variable: 'SERVER_JARFILE',
      default_value: 'velocity.jar',
      user_viewable: true,
      user_editable: true,
      rules: 'required|regex:/^([\\w\\d._-]+)(\\.jar)$/',
    },
  ],
};

/** BungeeCord and Waterfall share a config format; only the download differs. */
const bungeeConfig: PtdlEgg['config'] = {
  files: JSON.stringify({
    'config.yml': { parser: 'yaml', find: { 'listeners[0].host': '0.0.0.0:{{server.build.default.port}}', 'listeners[0].query_port': '{{server.build.default.port}}' } },
  }),
  startup: JSON.stringify({ done: 'Listening on ' }),
  logs: '{}',
  stop: 'end',
};

const bungeecord: PtdlEgg = {
  meta: { version: 'PTDL_v2' },
  uuid: '5a1b0f2e-6c0e-4a43-9a8d-2f1c7b3e9d21',
  name: 'BungeeCord',
  author: 'eggs@glacier.gg',
  description: 'The original Minecraft proxy by md_5. Link Spigot or Paper servers behind it from the Proxy tab.',
  features: ['java_version', 'pid_limit'],
  docker_images: PROXY_IMAGES,
  file_denylist: [],
  startup: PROXY_STARTUP,
  config: bungeeConfig,
  scripts: {
    installation: {
      container: 'ghcr.io/pterodactyl/installers:alpine',
      entrypoint: 'ash',
      script: `#!/bin/ash
# BungeeCord installation script: downloads the latest successful build from md_5's CI.
set -e
cd /mnt/server
echo "Installing BungeeCord"
if [ -f "$SERVER_JARFILE" ]; then mv "$SERVER_JARFILE" "$SERVER_JARFILE.old"; fi
curl -fsSL -o "$SERVER_JARFILE" https://ci.md-5.net/job/BungeeCord/lastSuccessfulBuild/artifact/bootstrap/target/BungeeCord.jar
echo "BungeeCord installed."
`,
    },
  },
  variables: [
    {
      name: 'Server Jar File',
      description: 'Name of the jar the proxy runs.',
      env_variable: 'SERVER_JARFILE',
      default_value: 'bungeecord.jar',
      user_viewable: true,
      user_editable: true,
      rules: 'required|regex:/^([\\w\\d._-]+)(\\.jar)$/',
    },
  ],
};

const waterfall: PtdlEgg = {
  ...bungeecord,
  uuid: '5a1b0f2e-6c0e-4a43-9a8d-2f1c7b3e9d22',
  name: 'Waterfall',
  description: "PaperMC's BungeeCord fork. No longer developed (PaperMC recommends Velocity), but kept for existing networks.",
  scripts: {
    installation: {
      container: 'ghcr.io/pterodactyl/installers:alpine',
      entrypoint: 'ash',
      script: `#!/bin/ash
# Waterfall installation script: downloads a build from PaperMC's Fill API.
set -e
cd /mnt/server
API=https://fill.papermc.io/v3/projects/waterfall

if [ -z "$WATERFALL_VERSION" ] || [ "$WATERFALL_VERSION" = "latest" ]; then
  WATERFALL_VERSION=$(curl -fsSL "$API" | jq -r '[.versions[][]][0]')
fi
echo "Installing Waterfall $WATERFALL_VERSION"
DOWNLOAD_URL=$(curl -fsSL "$API/versions/$WATERFALL_VERSION/builds/latest" | jq -r '.downloads."server:default".url')
if [ -z "$DOWNLOAD_URL" ] || [ "$DOWNLOAD_URL" = "null" ]; then
  echo "No Waterfall build found for $WATERFALL_VERSION"
  exit 1
fi
if [ -f "$SERVER_JARFILE" ]; then mv "$SERVER_JARFILE" "$SERVER_JARFILE.old"; fi
curl -fsSL -o "$SERVER_JARFILE" "$DOWNLOAD_URL"
echo "Waterfall installed."
`,
    },
  },
  variables: [
    {
      name: 'Waterfall Version',
      description: 'Minecraft version line, e.g. 1.21. "latest" picks the newest.',
      env_variable: 'WATERFALL_VERSION',
      default_value: 'latest',
      user_viewable: true,
      user_editable: true,
      rules: 'required|string|max:32',
    },
    ...(bungeecord.variables ?? []).map((v) => (v.env_variable === 'SERVER_JARFILE' ? { ...v, default_value: 'waterfall.jar' } : v)),
  ],
};

const nodejs: PtdlEgg = {
  meta: { version: 'PTDL_v2' },
  uuid: '5a1b0f2e-6c0e-4a43-9a8d-2f1c7b3e9d10',
  name: 'Node.js App',
  author: 'eggs@glacier.gg',
  description: 'Run any Node.js app or Discord bot. Optionally clones a Git repository on install.',
  features: [],
  docker_images: {
    'Node.js 22': 'ghcr.io/pterodactyl/yolks:nodejs_22',
    'Node.js 20': 'ghcr.io/pterodactyl/yolks:nodejs_20',
  },
  file_denylist: [],
  startup: 'if [ -f package.json ]; then npm install --omit=dev; fi; node {{MAIN_FILE}}',
  config: { files: '{}', startup: JSON.stringify({ done: '' }), logs: '{}', stop: '^C' },
  scripts: {
    installation: {
      container: 'node:22-bookworm-slim',
      entrypoint: 'bash',
      script: `#!/bin/bash
# Node.js installation script: optionally clones a repository into the server.
set -e
apt-get update -qq && apt-get install -y -qq git ca-certificates > /dev/null
mkdir -p /mnt/server && cd /mnt/server
if [ -n "$GIT_REPOSITORY" ]; then
  if [ -d .git ]; then
    git pull --ff-only
  elif [ -z "$(ls -A)" ]; then
    git clone --depth 1 \${GIT_BRANCH:+--branch "$GIT_BRANCH"} "$GIT_REPOSITORY" .
  else
    echo "Server directory is not empty; skipping clone."
  fi
fi
if [ -f package.json ]; then npm install --omit=dev; fi
echo "Node.js app installed."
`,
    },
  },
  variables: [
    {
      name: 'Main File',
      description: 'The file Node.js runs.',
      env_variable: 'MAIN_FILE',
      default_value: 'index.js',
      user_viewable: true,
      user_editable: true,
      rules: 'required|string|max:128',
    },
    {
      name: 'Git Repository',
      description: 'Optional HTTPS Git URL cloned on install.',
      env_variable: 'GIT_REPOSITORY',
      default_value: '',
      user_viewable: true,
      user_editable: true,
      rules: 'nullable|string|max:255',
    },
    {
      name: 'Git Branch',
      description: 'Branch to clone. Empty uses the default branch.',
      env_variable: 'GIT_BRANCH',
      default_value: '',
      user_viewable: true,
      user_editable: true,
      rules: 'nullable|string|max:64',
    },
  ],
};

const python: PtdlEgg = {
  meta: { version: 'PTDL_v2' },
  uuid: '5a1b0f2e-6c0e-4a43-9a8d-2f1c7b3e9d11',
  name: 'Python App',
  author: 'eggs@glacier.gg',
  description: 'Run any Python app or bot. Installs requirements.txt on every start.',
  features: [],
  docker_images: {
    'Python 3.12': 'ghcr.io/pterodactyl/yolks:python_3.12',
    'Python 3.11': 'ghcr.io/pterodactyl/yolks:python_3.11',
  },
  file_denylist: [],
  startup: 'if [ -f requirements.txt ]; then pip install -q -U --prefix .local -r requirements.txt; fi; python {{MAIN_FILE}}',
  config: { files: '{}', startup: JSON.stringify({ done: '' }), logs: '{}', stop: '^C' },
  scripts: {
    installation: {
      container: 'python:3.12-slim',
      entrypoint: 'bash',
      script: `#!/bin/bash
# Python installation script: optionally clones a repository into the server.
set -e
apt-get update -qq && apt-get install -y -qq git ca-certificates > /dev/null
mkdir -p /mnt/server && cd /mnt/server
if [ -n "$GIT_REPOSITORY" ] && [ -z "$(ls -A)" ]; then
  git clone --depth 1 "$GIT_REPOSITORY" .
fi
echo "Python app installed."
`,
    },
  },
  variables: [
    {
      name: 'Main File',
      description: 'The file Python runs.',
      env_variable: 'MAIN_FILE',
      default_value: 'main.py',
      user_viewable: true,
      user_editable: true,
      rules: 'required|string|max:128',
    },
    {
      name: 'Git Repository',
      description: 'Optional HTTPS Git URL cloned on install.',
      env_variable: 'GIT_REPOSITORY',
      default_value: '',
      user_viewable: true,
      user_editable: true,
      rules: 'nullable|string|max:255',
    },
  ],
};

export const BUNDLED_EGGS: { nest: string; nestDescription: string; egg: PtdlEgg }[] = [
  { nest: 'Minecraft', nestDescription: 'Minecraft: Java Edition servers.', egg: paper },
  { nest: 'Minecraft', nestDescription: 'Minecraft: Java Edition servers.', egg: purpur },
  { nest: 'Minecraft', nestDescription: 'Minecraft: Java Edition servers.', egg: fabric },
  { nest: 'Minecraft', nestDescription: 'Minecraft: Java Edition servers.', egg: vanilla },
  { nest: 'Minecraft Proxies', nestDescription: 'Proxies that link several Minecraft servers into one network.', egg: velocity },
  { nest: 'Minecraft Proxies', nestDescription: 'Proxies that link several Minecraft servers into one network.', egg: bungeecord },
  { nest: 'Minecraft Proxies', nestDescription: 'Proxies that link several Minecraft servers into one network.', egg: waterfall },
  { nest: 'Generic', nestDescription: 'General-purpose runtimes for apps and bots.', egg: nodejs },
  { nest: 'Generic', nestDescription: 'General-purpose runtimes for apps and bots.', egg: python },
];
