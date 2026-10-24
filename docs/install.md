# Installing Glacier Panel

Glacier Panel is free software you run on your own machines. It has two parts:

- **The panel** is the website plus its API and a PostgreSQL database. You need one.
- **Nodes** run **glacierd**, which starts game servers in Docker containers. You need at least one. The panel's machine can be a node too.

## Quick install (recommended)

Point your domain at the server (see [Before you start](#before-you-start)), then run this as root:

```bash
curl -fsSL https://raw.githubusercontent.com/BimuluDevelopment/glacier/master/installer/install.sh | sudo bash
```

The installer:

1. Checks the machine (OS, RAM, disk, virtualisation, ports, DNS).
2. Asks whether to install the panel, a node or both, then asks for your domain and an email for the certificate.
3. Installs Node.js, Docker, PostgreSQL, nginx and a Let's Encrypt certificate, generates the secrets, builds Glacier Panel into `/opt/glacier` and starts everything as systemd services.

For **panel and node** on one machine, it then waits for you to:

1. Open the panel and finish the setup wizard.
2. Create a node (Admin → Nodes → New node) with the panel's domain as its hostname.
3. Paste the pairing command shown on the node page into the installer, which then sets up the node.

**More nodes:** on each extra machine, paste the install command from that node's page in the panel. It looks like `curl -fsSL https://panel.example.com/install.sh | sudo bash -s -- daemon --panel … --token …`.

**Updating:** `sudo glacier update`

Running the installer again is safe: it keeps your config, secrets, certificates and pairing. Everything it does is logged to `/var/log/glacier-install.log`. Run it with `--help` to see all options, for example `--no-ssl` for a home server without a domain, or `--yes` for unattended installs.

After installing, add allocations (ports) to your node and create a server: see [step 9](#9-add-this-machine-as-a-node) and [step 11](#11-create-your-first-server).

## Manual install

The rest of this guide does the same thing by hand, for anyone who prefers that or runs an OS the installer doesn't support. It covers:

- **Part A:** the panel and a node on one VPS or dedicated server.
- **Part B:** adding more machines as nodes.
- **Part C:** optional extras: email, social sign-in, plugin sources, subdomains and MySQL databases. These apply to installer setups too.

Expect about 30 minutes for Part A.

---

## Before you start

| | Minimum | Recommended |
| --- | --- | --- |
| OS | Ubuntu 22.04 / 24.04 or Debian 12, 64-bit | Ubuntu 24.04 |
| CPU | 2 cores | 4+ cores |
| RAM | 2 GB (the panel and database use about 500 MB) | 8 GB+ for several game servers |
| Disk | 20 GB | SSD, sized for your worlds and backups |
| Virtualisation | KVM or a dedicated server. **OpenVZ/LXC containers usually can't run Docker.** | |

You also need:

- **Root access** (or sudo). Every command below runs as root, so if you use sudo, start with `sudo -i`.
- **A domain name** with an **A record** pointing at the server's IP. This guide uses `panel.example.com`; replace it everywhere. Before continuing, check that `ping panel.example.com` shows your server's IP.

**Ports used:**

| Port | What | Who connects |
| --- | --- | --- |
| 80, 443 | Panel website (HTTPS) | Browsers |
| 8080 | glacierd: console, uploads, downloads | Browsers and the panel |
| 2022 | SFTP | Your users' SFTP clients |
| 25565+ (your choice) | Game servers | Players |

---

# Part A: Panel and node on one machine

## 1. Install the system packages

```bash
apt update && apt upgrade -y
apt install -y curl git nginx certbot python3-certbot-nginx ufw

# Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs
node -v                 # must print v22 or newer

# Docker Engine + Compose plugin (skip if `docker compose version` already works)
curl -fsSL https://get.docker.com | sh
systemctl enable --now docker
docker compose version
```

## 2. Get the code

Put Glacier Panel in `/opt/glacier`:

```bash
git clone <your Glacier Panel repository URL> /opt/glacier
```

If you have the code as a folder on your own computer instead, pack it without build output and upload it:

```bash
# on your computer, inside the project folder
tar --exclude=node_modules --exclude=dist --exclude=.git -czf glacier.tgz .
scp glacier.tgz root@panel.example.com:/root/

# on the server
mkdir -p /opt/glacier && tar -xzf /root/glacier.tgz -C /opt/glacier
```

Either way, finish with:

```bash
chmod -R a+rX /opt/glacier
```

## 3. Build it

```bash
cd /opt/glacier
npm ci
npm run build
```

This builds the API, the daemon and the web app. A Vite warning about chunk size is normal.

## 4. Configure the panel and start the database

```bash
mkdir -p /etc/glacier
cp /opt/glacier/deploy/panel.env.example /etc/glacier/panel.env
chmod 600 /etc/glacier/panel.env
openssl rand -hex 32   # → APP_KEY
openssl rand -hex 24   # → database password
nano /etc/glacier/panel.env
```

Edit these values:

- `APP_URL=https://panel.example.com`: your domain, with no trailing slash. Passkeys and social sign-in are tied to this address.
- `APP_KEY`: the first random value. **Keep a copy somewhere safe.** It encrypts node secrets and integration tokens, and losing it means re-pairing every node and re-entering those tokens.
- The second random value goes in **both** `POSTGRES_PASSWORD` and the password part of `DATABASE_URL`.

Start PostgreSQL. It only listens on 127.0.0.1, so it is never reachable from the internet:

```bash
cd /opt/glacier
docker compose --env-file /etc/glacier/panel.env -f deploy/docker-compose.yml up -d
docker compose -f deploy/docker-compose.yml ps   # wait until it says "healthy"
```

Create the database tables:

```bash
cd /opt/glacier
set -a; . /etc/glacier/panel.env; set +a
npm run db:deploy
```

## 5. Run the panel as a service

```bash
useradd --system --no-create-home --shell /usr/sbin/nologin glacier-panel
cp /opt/glacier/deploy/systemd/glacier-panel.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now glacier-panel
curl -s http://127.0.0.1:3000/api/health   # → {"ok":true}
```

If the health check fails, `journalctl -u glacier-panel -n 50` shows why. The cause is usually a typo in `/etc/glacier/panel.env`.

## 6. Set up nginx and HTTPS

```bash
cp /opt/glacier/deploy/nginx/glacier.conf /etc/nginx/sites-available/glacier.conf
sed -i 's/panel.example.com/YOUR.DOMAIN.HERE/' /etc/nginx/sites-available/glacier.conf
ln -s /etc/nginx/sites-available/glacier.conf /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

certbot --nginx -d YOUR.DOMAIN.HERE   # choose "redirect" if asked
```

## 7. Set up the firewall

```bash
ufw allow 22/tcp     # SSH: keep this or you will lock yourself out
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 8080/tcp   # glacierd
ufw allow 2022/tcp   # SFTP
ufw enable
```

Game ports don't need ufw rules: Docker opens published ports itself and bypasses ufw. If your hosting provider has its own firewall in its control panel, open 80, 443, 8080, 2022 and your game ports there too (for example 25565–25600).

## 8. Create your admin account

Open `https://panel.example.com`. The setup wizard asks for a panel name and your admin email, username and password. It also installs the bundled server types ("eggs": Paper, Purpur, Fabric, Vanilla Minecraft, Node.js and Python) and a `default` location. When it finishes, you're on **Admin → Nodes**.

## 9. Add this machine as a node

Under **Admin → Nodes → New node**:

| Field | Value |
| --- | --- |
| Name | anything, e.g. `node-1` |
| Hostname (FQDN) | `panel.example.com` (the same domain, so the daemon can reuse its certificate) |
| Connection | HTTPS |
| Daemon port / SFTP port | `8080` / `2022` |
| Memory / Disk | what game servers may use in total, e.g. total RAM minus 1.5 GB |
| Server data directory | leave `/var/lib/glacier/volumes` |

After **Create node**, the panel shows two commands. For a manual install, use the second one (`glacierd pair …`); the first runs the installer. The pairing token works once and expires after an hour; **Re-pair daemon** on the node page makes a new one.

Then, on the node page, add **allocations** (the addresses and ports game servers may use):

- IP address: `0.0.0.0`
- Alias: `panel.example.com` (what players type)
- Ports: e.g. `25565-25600`

## 10. Install and pair glacierd

```bash
chmod +x /opt/glacier/apps/daemon/dist/index.js
ln -sf /opt/glacier/apps/daemon/dist/index.js /usr/local/bin/glacierd

glacierd pair --panel https://panel.example.com --token PASTE_TOKEN_HERE
```

This writes `/etc/glacier/config.yml`. The panel uses HTTPS, so browsers need the daemon on HTTPS too. Point it at the certificate certbot made:

```bash
nano /etc/glacier/config.yml
```

```yaml
api:
  host: 0.0.0.0
  port: 8080
  ssl:
    enabled: true
    cert: /etc/letsencrypt/live/panel.example.com/fullchain.pem
    key: /etc/letsencrypt/live/panel.example.com/privkey.pem
```

Check the setup, then start the daemon:

```bash
glacierd diagnostics   # Docker and Panel should both say "ok"
cp /opt/glacier/deploy/systemd/glacierd.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now glacierd
journalctl -u glacierd -n 30   # look for "glacierd … ready"
```

Restart the daemon whenever the certificate renews. Game servers keep running through the restart.

```bash
printf '#!/bin/sh\nsystemctl restart glacierd\n' > /etc/letsencrypt/renewal-hooks/deploy/glacierd.sh
chmod +x /etc/letsencrypt/renewal-hooks/deploy/glacierd.sh
```

The node page in the panel should now show **online** with your Docker version.

## 11. Create your first server

1. Go to **Admin → Servers → New server**. (Once you've saved presets under **Admin → Templates**, one click fills in this form.)
2. Pick an owner, the node, a free allocation and the **Paper** type.
3. Set **Accept Minecraft EULA** to `true`. The server won't start otherwise.
4. Click **Create server** and open its console. You'll see Paper download, then the server start.

Players connect to `panel.example.com:25565`, or whichever port you allocated.

Each server also gets:

- **Plugins** and **Players** tabs (Minecraft servers only).
- A version switcher under **Settings**.
- A file manager with search.
- Resource graphs, backups, schedules, subusers and SFTP.

The SFTP username is `<panel username>.<server id>` with the panel password. The server's **Settings** tab shows the exact username.

**That's it.** Part A is a complete install. Everything below is optional.

---

# Part B: Adding more machines as nodes

Any Linux machine with Docker can be a node, such as a second VPS or a dedicated server at home or in a datacentre. The panel isn't installed there; only glacierd is.

**1. Give it a hostname.** Create an A record such as `node2.example.com` that points at the machine.

**2. Install the packages:**

```bash
apt update && apt install -y curl git certbot ufw
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt install -y nodejs
curl -fsSL https://get.docker.com | sh && systemctl enable --now docker
```

**3. Get the code** into `/opt/glacier` as in [step 2](#2-get-the-code), then build just the daemon:

```bash
cd /opt/glacier
npm ci
npm run build -w @glacier/daemon
chmod -R a+rX /opt/glacier
chmod +x apps/daemon/dist/index.js
ln -sf /opt/glacier/apps/daemon/dist/index.js /usr/local/bin/glacierd
```

**4. Get a certificate.** Nothing else runs on port 80 here, so certbot can use standalone mode:

```bash
ufw allow 22/tcp && ufw allow 80/tcp && ufw allow 8080/tcp && ufw allow 2022/tcp && ufw enable
certbot certonly --standalone -d node2.example.com
```

Keep port 80 open, because certbot renews through it.

**5. Create the node in the panel.** Use **Hostname** `node2.example.com` and **Connection** HTTPS, then add its allocations. Use the machine's public IP or `0.0.0.0`, with `node2.example.com` as the alias.

**6. Pair it and start it.** Follow [step 10](#10-install-and-pair-glacierd), using `node2.example.com` in the certificate paths. Add the same certbot renewal hook.

The node's IP must be able to reach the panel over HTTPS, and browsers must be able to reach the node on port 8080. Keep the node's DNS record **unproxied** (grey cloud) if you use Cloudflare: SFTP and game traffic can't pass through Cloudflare's proxy.

---

# Part C: Optional extras

## Email

Under **Admin → Email**, enter your SMTP server (Mailgun, Postmark, your own mail server, and so on) and send a test. Email is needed for password resets. You can edit every message template on the same page.

## Sign in with Discord, Google or GitHub

Under **Admin → Security**:

1. Turn on a provider.
2. Paste the client ID and secret from that provider's developer console.
3. Add the redirect URL shown on the page to the provider's app settings. It looks like `https://panel.example.com/api/auth/oauth/discord/callback`.

Passkeys and two-factor authentication need no setup. Users turn them on from their **Account** page, and you can require two-factor for admins or for everyone under **Admin → Security**. Passkeys are tied to the domain in `APP_URL`, so changing the domain later means users must add them again.

## Plugin and mod browser

**Modrinth** and **Hangar** work out of the box. To add **CurseForge**, get a free API key at [console.curseforge.com](https://console.curseforge.com/) and paste it under **Admin → Settings → Integrations**.

Downloads go straight from the plugin site to the node, and each node only accepts files from these hosts:

```yaml
# /etc/glacier/config.yml (these are the defaults)
downloads:
  allowedHosts:
    - cdn.modrinth.com
    - hangarcdn.papermc.io
    - '*.forgecdn.net'
```

The node must be able to make outgoing HTTPS connections to them.

## Subdomains (Cloudflare)

These let users give a server an address like `survival.play.example.com` instead of an IP and port. The panel creates the DNS record and the Minecraft SRV record, so players don't need to type the port.

1. Your domain must use Cloudflare DNS.
2. In Cloudflare, go to **My Profile → API Tokens → Create Token** and use the **Edit zone DNS** template, limited to your domain.
3. Paste the token under **Admin → Settings → Integrations → Cloudflare**, click **Check & save**, then tick the domains users may use and set how many subdomains each server can have.
4. Under **Admin → Settings → Modules**, turn on **Subdomains**.

Users then add subdomains from their server's **Network** tab.

## Minecraft networks (Velocity, BungeeCord, Waterfall)

A proxy links several Minecraft servers into one network: players join one address and move between servers such as `lobby` and `survival` with `/server <name>`.

1. Installs from before this feature need the proxy eggs. Under **Admin → Eggs**, click the button that adds the bundled eggs; this adds **Velocity**, **BungeeCord** and **Waterfall**.
2. Create a server with the **Velocity** egg and a public port, e.g. 25565. Velocity is the recommended proxy.
3. Open the new server's **Proxy** tab and click **Add server**. Each server you add:
   - runs on the same machine, behind the proxy;
   - gets a port that only listens on the machine itself (30000–30999), so players can't skip the proxy;
   - has player forwarding set up for you: Velocity's signed forwarding, or IP forwarding for BungeeCord and Waterfall;
   - is added to the proxy's server list. The proxy reloads straight away if it's running.
4. From the same tab, choose which servers players join first, change the order, and set **forced hosts**, e.g. `survival.example.com` going straight to `survival`.

**Link existing** adds a Paper server you already have on that machine. Restart it afterwards so it picks up the forwarding settings.

Server owners who aren't admins can add servers to their own proxy once you allow it. Set the limits (servers, memory, disk, CPU) in the **Proxy network** card on the proxy's page under **Admin → Servers**.

> BungeeCord and Waterfall don't sign the player details they forward. Players can only reach the network through the proxy, but other servers on the same machine could still connect to a backend directly. Use Velocity, or install BungeeGuard, if you host servers for other people on that machine.

## MySQL databases for game servers

Plugins like LuckPerms or CoreProtect want a MySQL database. To let users create one from their server's **Databases** tab, install MariaDB on a node and add it as a database host:

```bash
apt install -y mariadb-server
sed -i 's/^bind-address.*/bind-address = 0.0.0.0/' /etc/mysql/mariadb.conf.d/50-server.cnf
systemctl restart mariadb
mariadb -e "CREATE USER 'glacier'@'%' IDENTIFIED BY 'PICK_A_STRONG_PASSWORD'; GRANT ALL PRIVILEGES ON *.* TO 'glacier'@'%' WITH GRANT OPTION; FLUSH PRIVILEGES;"
ufw allow from 172.30.0.0/16 to any port 3306 proto tcp   # game server containers only
```

Port 3306 stays closed to the internet. MariaDB isn't in Docker, so ufw applies to it.

Then go to **Admin → Databases → Add host** and enter:

- Host `172.30.0.1` (the address game servers use to reach the machine they run on)
- Port `3306`
- User `glacier`, with that password

The panel tests the login before saving. Finally, give each server a database limit in its **Limits**.

---

# Looking after your install

## Updating

If you installed with the installer, or with `git clone`, run:

```bash
sudo glacier update
```

It downloads the latest code, rebuilds, updates the database and restarts whatever is installed on that machine. Run it on every machine.

For an install from an uploaded archive, extract the new archive over `/opt/glacier`, then:

```bash
cd /opt/glacier
npm ci && npm run build
set -a; . /etc/glacier/panel.env; set +a; npm run db:deploy
systemctl restart glacier-panel glacierd
```

On extra nodes, run only `npm ci && npm run build -w @glacier/daemon && systemctl restart glacierd`. Game servers keep running while glacierd restarts.

## Backups

Back these up regularly, preferably to another machine:

| What | Where / how |
| --- | --- |
| Panel database | `docker exec glacier-postgres-1 pg_dump -U glacier glacier > glacier-$(date +%F).sql` |
| Config and secrets (including `APP_KEY`) | `/etc/glacier/` on every machine |
| Server files | `/var/lib/glacier/volumes/` on each node |
| Backups made from the Backups tab | `/var/lib/glacier/backups/` on each node |
| Game server databases | `mysqldump --all-databases > databases.sql` (if you set up MariaDB) |

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| Browser shows **502 Bad Gateway** | `systemctl status glacier-panel` and `journalctl -u glacier-panel -n 50` |
| Node shows **offline** | `glacierd diagnostics`; `journalctl -u glacierd -n 50`; is 8080 open in ufw **and** in your provider's firewall? |
| Console says it **can't reach the node** | Open `https://<node hostname>:8080/api/system` in your browser. A JSON "Invalid or missing panel token" error means TLS and the port are fine. A certificate or connection error means the `ssl` paths in `/etc/glacier/config.yml` or the firewall are wrong. |
| Uploads or downloads fail with **"Couldn't reach the node"** | Same check as above. File transfers go straight to the node on 8080. |
| glacierd exits with **"overlaps an existing network"** | Another Docker network uses `172.30.0.0/16`. In `/etc/glacier/config.yml`, set `docker.network.subnet` to a free range (e.g. `172.31.0.0/16`) and `docker.network.interface` to its `.1` address. |
| Server stuck on **Installing** or **Install failed** | `/var/log/glacier/install/<server uuid>.log` on the node |
| Minecraft starts then stops immediately | Set **Accept Minecraft EULA** to `true` and start it again. |
| Plugin install fails with **"Downloads from … are not allowed on this node"** | Add the download host to `downloads.allowedHosts` in `/etc/glacier/config.yml` and restart glacierd. |
| A CurseForge file says **download it yourself** | That author doesn't allow automatic downloads. Download the file from the project page and upload it in the file manager. |
| SFTP says **authentication failed** | The username must be `<panel username>.<server id>`, and the user needs the "Connect over SFTP" permission. After 5 wrong passwords, logins pause for 5 minutes. |
| Database host **can't connect** | `ufw status` must allow 172.30.0.0/16 to port 3306, and MariaDB's `bind-address` must not be 127.0.0.1. |
| Cloudflare token is **refused** | The token needs **Zone → DNS → Edit** permission for your domain, and it must not have expired. |
| Passkey or social sign-in fails | `APP_URL` must exactly match the address in the browser, including `https://`. |
| Setting changes don't show up | Hard-refresh the browser (Ctrl+F5). |
