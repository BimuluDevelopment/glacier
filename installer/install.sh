#!/usr/bin/env bash
# Glacier Panel installer.
#
#   curl -sSL https://raw.githubusercontent.com/BimuluDevelopment/glacier/main/installer/install.sh | sudo bash
#
# It downloads Glacier Panel to /opt/glacier and installs everything it needs (Node.js, Docker,
# PostgreSQL, nginx, a Let's Encrypt certificate, systemd services, firewall rules).
# Modes and options: see usage() below, or run it with --help.
#
# Running it again is safe: existing config, secrets, certificates and pairing are kept.
# Everything is logged to /var/log/glacier-install.log.

set -Eeuo pipefail

REPO_URL="${GLACIER_REPO:-https://github.com/BimuluDevelopment/glacier.git}"
BRANCH="${GLACIER_BRANCH:-main}"
INSTALL_DIR=/opt/glacier
CONFIG_DIR=/etc/glacier
PANEL_ENV="$CONFIG_DIR/panel.env"
DAEMON_CONFIG="$CONFIG_DIR/config.yml"
LOG=/var/log/glacier-install.log

MODE=""
DOMAIN=""
EMAIL=""
PANEL_URL=""
TOKEN=""
FQDN=""
APP_URL=""
SSL=1
ASSUME_YES=0

# --- output ---------------------------------------------------------------------------------

if [[ -t 1 ]]; then
  BOLD=$'\e[1m' DIM=$'\e[2m' RED=$'\e[31m' GREEN=$'\e[32m' YELLOW=$'\e[33m' CYAN=$'\e[36m' RESET=$'\e[0m'
else
  BOLD="" DIM="" RED="" GREEN="" YELLOW="" CYAN="" RESET=""
fi

log() { printf '%s\n' "$*" 2>/dev/null >>"$LOG" || true; }
step() {
  printf '\n%s%s==>%s %s%s%s\n' "$BOLD" "$CYAN" "$RESET" "$BOLD" "$*" "$RESET"
  log "" "==> $*"
}
ok() {
  printf '    %s✓%s %s\n' "$GREEN" "$RESET" "$*"
  log "ok: $*"
}
warn() {
  printf '    %s!%s %s\n' "$YELLOW" "$RESET" "$*"
  log "warning: $*"
}
die() {
  printf '\n%sError:%s %s\n' "$RED" "$RESET" "$*" >&2
  log "error: $*"
  exit 1
}

# Run a command with its output going to the log; show the end of it if it fails.
run() {
  local desc=$1
  shift
  printf '    %s… ' "$desc"
  log "+ $*"
  if "$@" >>"$LOG" 2>&1; then
    printf '%sdone%s\n' "$GREEN" "$RESET"
  else
    local rc=$?
    printf '%sfailed%s\n' "$RED" "$RESET"
    tail -n 20 "$LOG" | sed "s/^/      ${DIM}/;s/\$/${RESET}/"
    die "$desc failed (exit $rc). Full log: $LOG"
  fi
}

# --- questions ------------------------------------------------------------------------------

# When piped from curl, stdin is the script itself, so questions go to the terminal directly.
TTY=""
if [[ -r /dev/tty ]] && { : </dev/tty; } 2>/dev/null; then TTY=/dev/tty; fi

interactive() { [[ -n $TTY && $ASSUME_YES -eq 0 ]]; }

# ask VAR "Question" "default" "--flag": fills VAR unless it is already set.
ask() {
  local var=$1 question=$2 default=${3-} flag=${4-} answer
  [[ -n ${!var} ]] && return 0
  if ! interactive; then
    [[ -n $default ]] || die "Missing ${flag:-$var}. Pass it as an option, or run the installer in a terminal."
    printf -v "$var" '%s' "$default"
    return 0
  fi
  while true; do
    if [[ -n $default ]]; then
      printf '    %s?%s %s %s[%s]%s ' "$CYAN" "$RESET" "$question" "$DIM" "$default" "$RESET" >"$TTY"
    else
      printf '    %s?%s %s ' "$CYAN" "$RESET" "$question" >"$TTY"
    fi
    IFS= read -r answer <"$TTY" || answer=""
    answer=${answer:-$default}
    if [[ -n $answer ]]; then
      printf -v "$var" '%s' "$answer"
      return 0
    fi
  done
}

# confirm "Question" Y|N: returns 0 for yes. Without a terminal (or with --yes) the default wins.
confirm() {
  local question=$1 default=${2:-Y} answer hint="[Y/n]"
  [[ $default == N ]] && hint="[y/N]"
  if ! interactive; then [[ $default == Y ]]; return; fi
  printf '    %s?%s %s %s ' "$CYAN" "$RESET" "$question" "$hint" >"$TTY"
  IFS= read -r answer <"$TTY" || answer=""
  answer=${answer:-$default}
  [[ $answer =~ ^[Yy] ]]
}

choose_mode() {
  [[ -n $MODE ]] && return 0
  if ! interactive; then
    MODE=all
    return 0
  fi
  printf '\n    What should this machine run?\n' >"$TTY"
  printf '      %s1%s  Panel and node (everything on one server)  %s← most people%s\n' "$BOLD" "$RESET" "$DIM" "$RESET" >"$TTY"
  printf '      %s2%s  Panel only\n' "$BOLD" "$RESET" >"$TTY"
  printf '      %s3%s  Node only (add this machine to an existing panel)\n' "$BOLD" "$RESET" >"$TTY"
  local pick=""
  ask pick "Choose 1, 2 or 3:" "1"
  case $pick in
    1) MODE=all ;;
    2) MODE=panel ;;
    3) MODE=daemon ;;
    *) die "Please run the installer again and choose 1, 2 or 3." ;;
  esac
}

# --- checks ---------------------------------------------------------------------------------

preflight() {
  step "Checking this machine"
  [[ $EUID -eq 0 ]] || die "Run the installer as root, e.g. with: curl -sSL … | sudo bash"
  command -v systemctl >/dev/null || die "systemd is required."
  [[ -r /etc/os-release ]] || die "Can't tell which Linux this is (/etc/os-release is missing)."
  # shellcheck disable=SC1091
  . /etc/os-release
  case "${ID:-}:${VERSION_ID:-}" in
    ubuntu:22.04 | ubuntu:24.04 | debian:12) ok "${PRETTY_NAME}" ;;
    ubuntu:* | debian:*)
      warn "${PRETTY_NAME} hasn't been tested. Ubuntu 22.04/24.04 and Debian 12 are supported."
      confirm "Continue anyway?" N || exit 1
      ;;
    *) die "The installer supports Ubuntu 22.04/24.04 and Debian 12 (this is ${PRETTY_NAME:-unknown}). See docs/install.md to install by hand." ;;
  esac

  case "$(uname -m)" in
    x86_64 | aarch64) ok "CPU architecture $(uname -m)" ;;
    *) die "Unsupported CPU architecture $(uname -m). Glacier Panel needs x86_64 or arm64." ;;
  esac

  if [[ $MODE == all || $MODE == daemon ]]; then
    local virt
    virt=$(systemd-detect-virt --container 2>/dev/null || true)
    case $virt in
      openvz | lxc | lxc-libvirt | systemd-nspawn)
        die "This machine is a ${virt} container, which can't run Docker reliably. Game servers need a KVM VPS or a dedicated server."
        ;;
    esac
  fi

  local mem disk
  mem=$(awk '/^MemTotal:/ { print int($2 / 1024) }' /proc/meminfo)
  disk=$(df -Pm / | awk 'NR == 2 { print $4 }')
  if ((mem < 1800)); then warn "Only ${mem} MB RAM. 2 GB is the minimum; game servers need more."; else ok "${mem} MB RAM"; fi
  if ((disk < 10240)); then warn "Only $((disk / 1024)) GB free disk space. 20 GB or more is recommended."; else ok "$((disk / 1024)) GB free disk space"; fi

  local ports=()
  [[ $MODE == all || $MODE == panel ]] && ports+=(80 443)
  [[ $MODE == all || $MODE == daemon ]] && ports+=(8080 2022)
  local port owner
  for port in "${ports[@]}"; do
    owner=$(ss -Hltnp "sport = :$port" 2>/dev/null | grep -o 'users:(("[^"]*' | head -n 1 | cut -d'"' -f2 || true)
    case $owner in
      "" | nginx | node | docker-proxy) ;;
      *) warn "Port $port is already used by ${owner}. Glacier Panel needs it." ;;
    esac
  done
}

# Warn when a domain doesn't point at this server (the certificate request would fail).
check_dns() {
  local name=$1 public resolved
  public=$(curl -4 -fsS --max-time 5 https://api.ipify.org 2>/dev/null || true)
  resolved=$(getent ahostsv4 "$name" 2>/dev/null | awk 'NR == 1 { print $1 }' || true)
  if [[ -z $resolved ]]; then
    warn "$name doesn't resolve yet. Create an A record pointing it at ${public:-this server's IP}, then wait a few minutes."
    confirm "Continue anyway? (getting the HTTPS certificate will fail)" N || exit 1
  elif [[ -n $public && $resolved != "$public" ]]; then
    warn "$name points at $resolved, but this server's public IP is $public."
    warn "That's fine behind a Cloudflare proxy; otherwise fix the A record first."
    confirm "Continue?" Y || exit 1
  else
    ok "$name points at this server ($resolved)"
  fi
}

# --- system packages ------------------------------------------------------------------------

apt_install() { DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=300 install -y -q "$@"; }

install_base() {
  step "Installing system packages"
  run "Updating package lists" apt-get -o DPkg::Lock::Timeout=300 update -q
  run "Installing base tools" apt_install curl ca-certificates git openssl gnupg ufw iproute2

  if command -v node >/dev/null && (($(node -p 'process.versions.node.split(".")[0]') >= 22)); then
    ok "Node.js $(node -v) already installed"
  else
    run "Adding the Node.js 22 repository" bash -c 'curl -fsSL https://deb.nodesource.com/setup_22.x | bash -'
    run "Installing Node.js 22" apt_install nodejs
  fi

  if command -v docker >/dev/null && docker compose version >/dev/null 2>&1; then
    ok "Docker $(docker version --format '{{.Server.Version}}' 2>/dev/null || echo '') already installed"
  else
    run "Installing Docker" bash -c 'curl -fsSL https://get.docker.com | sh'
  fi
  run "Starting Docker" systemctl enable --now docker
}

# --- code -----------------------------------------------------------------------------------

fetch_code() {
  step "Downloading Glacier Panel"
  if [[ -d $INSTALL_DIR/.git ]]; then
    run "Updating $INSTALL_DIR ($BRANCH)" git -C "$INSTALL_DIR" pull --ff-only origin "$BRANCH"
  elif [[ -d $INSTALL_DIR && -n $(ls -A "$INSTALL_DIR" 2>/dev/null) ]]; then
    die "$INSTALL_DIR already exists but wasn't installed with git. Move it away first, or update it by hand (docs/install.md)."
  else
    run "Cloning $REPO_URL" git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$INSTALL_DIR"
  fi
  ok "Version $(git -C "$INSTALL_DIR" rev-parse --short HEAD)"
}

build() {
  local what=$1 marker="$INSTALL_DIR/.glacier-build" rev built=""
  step "Building"
  cd "$INSTALL_DIR"
  rev=$(git rev-parse HEAD)
  [[ -f $marker ]] && built=$(cat "$marker")
  # A panel build includes glacierd, so it also covers a later daemon-only run.
  if [[ $built == "$rev panel" || $built == "$rev $what" ]]; then
    ok "Already built at this version"
  else
    run "Installing dependencies (this takes a few minutes)" npm ci --no-audit --no-fund
    if [[ $what == daemon ]]; then
      run "Building glacierd" npm run build -w @glacier/daemon
    else
      run "Building the panel and glacierd" npm run build
    fi
    printf '%s %s\n' "$rev" "$what" >"$marker"
  fi
  chmod -R a+rX "$INSTALL_DIR"
  chmod +x "$INSTALL_DIR/apps/daemon/dist/index.js" "$INSTALL_DIR/installer/install.sh"
  ln -sf "$INSTALL_DIR/apps/daemon/dist/index.js" /usr/local/bin/glacierd
  ln -sf "$INSTALL_DIR/installer/install.sh" /usr/local/bin/glacier
}

# --- firewall -------------------------------------------------------------------------------

setup_firewall() {
  command -v ufw >/dev/null || return 0
  step "Firewall"
  local ssh_port active=0 port
  ssh_port=$(sshd -T 2>/dev/null | awk '$1 == "port" { print $2; exit }' || true)
  ssh_port=${ssh_port:-22}
  ufw status 2>/dev/null | grep -q 'Status: active' && active=1
  for port in "$ssh_port" "$@"; do
    ufw allow "$port/tcp" >>"$LOG" 2>&1
  done
  ok "Allowed SSH ($ssh_port) and ports $*"
  if ((active)); then
    ok "ufw is on"
  elif confirm "Turn on the ufw firewall? (SSH on port $ssh_port stays open)" Y; then
    run "Turning on ufw" ufw --force enable
  else
    warn "ufw left off"
  fi
  warn "If your provider has a firewall in its control panel, open ports $* (and your game ports) there too."
}

# --- panel ----------------------------------------------------------------------------------

panel_env_value() { grep -E "^$1=" "$PANEL_ENV" | head -n 1 | cut -d= -f2-; }

write_panel_env() {
  if [[ -f $PANEL_ENV ]]; then
    APP_URL=$(panel_env_value APP_URL)
    ok "Keeping the existing $PANEL_ENV ($APP_URL)"
    return 0
  fi
  local key db
  key=$(openssl rand -hex 32)
  db=$(openssl rand -hex 24)
  install -d -m 755 "$CONFIG_DIR"
  (
    umask 077
    sed -e "s|^APP_URL=.*|APP_URL=$APP_URL|" \
      -e "s|^APP_KEY=.*|APP_KEY=$key|" \
      -e "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$db|" \
      -e "s|glacier:CHANGE_ME@|glacier:$db@|" \
      "$INSTALL_DIR/deploy/panel.env.example" >"$PANEL_ENV"
  )
  ok "Generated secrets in $PANEL_ENV. Keep a backup of this file."
}

start_database() {
  run "Starting PostgreSQL" docker compose --env-file "$PANEL_ENV" -f "$INSTALL_DIR/deploy/docker-compose.yml" up -d
  local i status=""
  for i in $(seq 1 60); do
    status=$(docker inspect -f '{{.State.Health.Status}}' glacier-postgres-1 2>/dev/null || true)
    [[ $status == healthy ]] && break
    sleep 2
  done
  [[ $status == healthy ]] || die "PostgreSQL didn't become ready. Check: docker logs glacier-postgres-1"
  ok "PostgreSQL is ready"
}

migrate_database() {
  run "Updating the database tables" bash -c "set -a; . '$PANEL_ENV'; set +a; cd '$INSTALL_DIR' && npm run db:deploy"
}

start_panel_service() {
  id glacier-panel >/dev/null 2>&1 || run "Creating the glacier-panel user" useradd --system --no-create-home --shell /usr/sbin/nologin glacier-panel
  install -m 644 "$INSTALL_DIR/deploy/systemd/glacier-panel.service" /etc/systemd/system/glacier-panel.service
  systemctl daemon-reload
  systemctl enable glacier-panel >>"$LOG" 2>&1
  run "Starting the panel" systemctl restart glacier-panel
  local i
  for i in $(seq 1 30); do
    if curl -fsS http://127.0.0.1:3000/api/health >/dev/null 2>&1; then
      ok "The panel is running"
      return 0
    fi
    sleep 1
  done
  die "The panel didn't start. See: journalctl -u glacier-panel -n 50"
}

setup_nginx() {
  local domain=$1 site=/etc/nginx/sites-available/glacier.conf
  command -v nginx >/dev/null || run "Installing nginx" apt_install nginx
  if [[ -f $site ]]; then
    ok "Keeping the existing nginx site ($site)"
  else
    sed "s/panel\.example\.com/$domain/g" "$INSTALL_DIR/deploy/nginx/glacier.conf" >"$site"
    ln -sf "$site" /etc/nginx/sites-enabled/glacier.conf
    rm -f /etc/nginx/sites-enabled/default
    ok "Created the nginx site for $domain"
  fi
  run "Checking the nginx config" nginx -t
  systemctl enable nginx >>"$LOG" 2>&1
  run "Reloading nginx" systemctl reload-or-restart nginx

  ((SSL)) || return 0
  if grep -q 'ssl_certificate' "$site"; then
    ok "HTTPS is already set up"
    return 0
  fi
  run "Installing certbot" apt_install certbot python3-certbot-nginx
  run "Getting an HTTPS certificate for $domain" \
    certbot --nginx -d "$domain" --non-interactive --agree-tos -m "$EMAIL" --redirect --keep-until-expiring
}

install_panel() {
  step "Setting up the panel"
  if [[ -f $PANEL_ENV ]]; then
    APP_URL=$(panel_env_value APP_URL)
    DOMAIN=${APP_URL#*://}
    [[ $APP_URL == https://* ]] || SSL=0
  else
    ask DOMAIN "Panel domain (e.g. panel.example.com):" "" --domain
    DOMAIN=${DOMAIN#*://}
    DOMAIN=${DOMAIN%%/*}
    [[ $DOMAIN =~ ^[A-Za-z0-9.-]+$ ]] || die "\"$DOMAIN\" isn't a valid domain or IP address."
    if ((SSL)); then
      ask EMAIL "Email for certificate expiry notices:" "" --email
      APP_URL="https://$DOMAIN"
    else
      APP_URL="http://$DOMAIN"
    fi
  fi
  ((SSL)) && check_dns "$DOMAIN"
  write_panel_env
  start_database
  migrate_database
  start_panel_service
  setup_nginx "$DOMAIN"
}

# --- daemon ---------------------------------------------------------------------------------

# Read or change glacierd's YAML config with the yaml package glacierd itself uses.
daemon_config() {
  node -e '
    const { createRequire } = require("node:module");
    const fs = require("node:fs");
    const YAML = createRequire(process.argv[1] + "/apps/daemon/package.json")("yaml");
    const [, , file, action, ...args] = process.argv;
    const config = YAML.parse(fs.readFileSync(file, "utf8"));
    if (action === "get") {
      const value = args[0].split(".").reduce((o, k) => (o == null ? undefined : o[k]), config);
      process.stdout.write(value == null ? "" : String(value));
    } else if (action === "ssl") {
      config.api = { ...config.api, ssl: { enabled: true, cert: args[0], key: args[1] } };
      fs.writeFileSync(file, "# glacierd configuration. Generated by \"glacierd pair\"; safe to edit.\n" + YAML.stringify(config), { mode: 0o600 });
    }
  ' "$INSTALL_DIR" "$DAEMON_CONFIG" "$@"
}

pair_daemon() {
  if [[ -f $DAEMON_CONFIG && -z $TOKEN ]]; then
    ok "Already paired with $(daemon_config get panel.url) (keeping $DAEMON_CONFIG)"
    return 0
  fi
  ask PANEL_URL "Panel URL (e.g. https://panel.example.com):" "$APP_URL" --panel
  ask TOKEN "Pairing token (from Admin → Nodes → your node):" "" --token
  # Accept the whole command copied from the panel, too.
  if [[ $TOKEN == *--token* ]]; then TOKEN=$(sed -E 's/.*--token[ =]+([^ ]+).*/\1/' <<<"$TOKEN"); fi
  local force=()
  [[ -f $DAEMON_CONFIG ]] && force=(--force)
  run "Pairing with $PANEL_URL" glacierd pair --panel "${PANEL_URL%/}" --token "$TOKEN" "${force[@]}"
}

setup_daemon_tls() {
  local panel ssl cert_dir hook=/etc/letsencrypt/renewal-hooks/deploy/glacierd.sh
  panel=$(daemon_config get panel.url)
  if [[ $panel != https://* ]]; then
    ok "The panel uses HTTP, so glacierd does too"
    return 0
  fi
  ssl=$(daemon_config get api.ssl.enabled)
  if [[ $ssl == true && -f $(daemon_config get api.ssl.cert) ]]; then
    ok "HTTPS is already set up for glacierd"
    return 0
  fi
  # The hostname set on the node in the panel (saved at pairing) is the one browsers will use.
  [[ -n $FQDN ]] || FQDN=$(daemon_config get api.fqdn)
  ask FQDN "This node's hostname (e.g. node1.example.com):" "$DOMAIN" --fqdn
  cert_dir="/etc/letsencrypt/live/$FQDN"
  if [[ -f $cert_dir/fullchain.pem ]]; then
    ok "Using the existing certificate for $FQDN"
  else
    check_dns "$FQDN"
    ask EMAIL "Email for certificate expiry notices:" "" --email
    if systemctl is-active --quiet nginx; then
      run "Installing certbot" apt_install certbot python3-certbot-nginx
      run "Getting an HTTPS certificate for $FQDN" certbot certonly --nginx -d "$FQDN" --non-interactive --agree-tos -m "$EMAIL" --keep-until-expiring
    else
      run "Installing certbot" apt_install certbot
      run "Getting an HTTPS certificate for $FQDN" certbot certonly --standalone -d "$FQDN" --non-interactive --agree-tos -m "$EMAIL" --keep-until-expiring
    fi
  fi
  daemon_config ssl "$cert_dir/fullchain.pem" "$cert_dir/privkey.pem"
  install -d "$(dirname "$hook")"
  printf '#!/bin/sh\n# Load renewed certificates. Game servers keep running.\nsystemctl restart glacierd\n' >"$hook"
  chmod +x "$hook"
  ok "glacierd uses HTTPS with the certificate for $FQDN"
}

start_daemon_service() {
  install -m 644 "$INSTALL_DIR/deploy/systemd/glacierd.service" /etc/systemd/system/glacierd.service
  systemctl daemon-reload
  systemctl enable glacierd >>"$LOG" 2>&1
  run "Starting glacierd" systemctl restart glacierd
  sleep 3
  if systemctl is-active --quiet glacierd; then ok "glacierd is running"; else die "glacierd didn't start. See: journalctl -u glacierd -n 50"; fi
  printf '\n'
  glacierd diagnostics 2>&1 | tee -a "$LOG" | sed 's/^/  /'
}

install_daemon() {
  step "Setting up the node (glacierd)"
  pair_daemon
  setup_daemon_tls
  start_daemon_service
}

# In "all" mode the node can only be paired once the admin account and node exist in the panel.
pair_after_panel() {
  if [[ ! -f $DAEMON_CONFIG && -z $TOKEN ]]; then
    printf '\n    %sThe panel is up. Now pair this machine as a node:%s\n' "$BOLD" "$RESET" >"$TTY"
    printf '      1. Open %s%s%s and finish the setup wizard.\n' "$CYAN" "$APP_URL" "$RESET" >"$TTY"
    printf '      2. Go to Admin → Nodes → New node. Hostname: %s%s%s, port 8080%s.\n' "$BOLD" "$DOMAIN" "$RESET" "$( ((SSL)) && echo ', HTTPS')" >"$TTY"
    printf '      3. Copy the pairing command (or just its token) and paste it below.\n\n' >"$TTY"
  fi
  PANEL_URL=${PANEL_URL:-$APP_URL}
  install_daemon
}

# --- modes ----------------------------------------------------------------------------------

summary() {
  step "Done"
  if [[ -n $APP_URL ]]; then printf '    Panel:   %s%s%s\n' "$CYAN" "$APP_URL" "$RESET"; fi
  if systemctl is-active --quiet glacierd 2>/dev/null; then printf '    Node:    glacierd is running (%s)\n' "$(daemon_config get panel.url)"; fi
  printf '    Config:  %s  %s(back up this folder; it holds your secrets)%s\n' "$CONFIG_DIR" "$DIM" "$RESET"
  printf '    Log:     %s\n' "$LOG"
  printf '    Update:  %ssudo glacier update%s\n' "$BOLD" "$RESET"
  printf '\n    Next: in the panel, add allocations (ports) to your node and create a server.\n'
  printf '    Guide: %s/docs/install.md\n\n' "${REPO_URL%.git}/blob/$BRANCH"
}

do_update() {
  [[ -d $INSTALL_DIR/.git ]] || die "Nothing to update: $INSTALL_DIR isn't a git install."
  local has_panel=0 has_daemon=0
  [[ -f /etc/systemd/system/glacier-panel.service ]] && has_panel=1
  [[ -f /etc/systemd/system/glacierd.service ]] && has_daemon=1
  ((has_panel || has_daemon)) || die "Neither the panel nor glacierd is installed here. Run the installer without \"update\"."
  fetch_code
  if ((has_panel)); then build panel; else build daemon; fi
  if ((has_panel)); then
    step "Updating the panel"
    APP_URL=$(panel_env_value APP_URL)
    start_database
    migrate_database
    start_panel_service
  fi
  if ((has_daemon)); then
    step "Updating glacierd"
    start_daemon_service
  fi
}

usage() {
  cat <<'EOF'
Glacier Panel installer

  install.sh [all|panel|daemon|update] [options]

  all       panel and node on this machine (asked for when no mode is given)
  panel     only the panel
  daemon    only a node: installs glacierd and pairs it with your panel
  update    download the latest code and rebuild whatever is installed here

Options:
  --domain <name>   panel domain, e.g. panel.example.com
  --email <addr>    email for Let's Encrypt expiry notices
  --panel <url>     (daemon) panel URL, e.g. https://panel.example.com
  --token <token>   (daemon) pairing token from Admin → Nodes
  --fqdn <name>     (daemon) override the node hostname used for its certificate
  --no-ssl          plain HTTP, e.g. on a home network without a domain
  --repo <url>      git repository to install from
  --branch <name>   branch to install (default: main)
  -y, --yes         don't ask questions; use the options and defaults

After installing, update with: sudo glacier update
EOF
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case $1 in
      all | panel | daemon | update) MODE=$1 ;;
      --domain | --email | --panel | --token | --fqdn | --repo | --branch)
        [[ $# -ge 2 ]] || die "$1 needs a value."
        case $1 in
          --domain) DOMAIN=$2 ;;
          --email) EMAIL=$2 ;;
          --panel) PANEL_URL=$2 ;;
          --token) TOKEN=$2 ;;
          --fqdn) FQDN=$2 ;;
          --repo) REPO_URL=$2 ;;
          --branch) BRANCH=$2 ;;
        esac
        shift
        ;;
      --no-ssl) SSL=0 ;;
      -y | --yes) ASSUME_YES=1 ;;
      -h | --help)
        usage
        exit 0
        ;;
      *) die "Unknown option \"$1\". Run with --help for usage." ;;
    esac
    shift
  done
}

main() {
  parse_args "$@"
  [[ $EUID -eq 0 ]] || die "Run the installer as root, e.g. with: curl -sSL … | sudo bash"
  mkdir -p "$(dirname "$LOG")"
  log "" "===== Glacier Panel installer, $(date -u '+%Y-%m-%d %H:%M:%S UTC'), args: $* ====="
  printf '\n%s  Glacier Panel installer%s\n' "$BOLD" "$RESET"
  trap 'die "Unexpected failure on line $LINENO. Full log: $LOG"' ERR

  if [[ $MODE == update ]]; then
    do_update
    summary
    return 0
  fi

  choose_mode
  preflight
  install_base
  case $MODE in
    all) setup_firewall 80 443 8080 2022 ;;
    panel) setup_firewall 80 443 ;;
    daemon) setup_firewall 80 8080 2022 ;;
  esac
  fetch_code
  if [[ $MODE == daemon ]]; then build daemon; else build panel; fi

  case $MODE in
    panel) install_panel ;;
    daemon) install_daemon ;;
    all)
      install_panel
      if [[ -f $DAEMON_CONFIG || -n $TOKEN ]] || interactive; then
        pair_after_panel
      else
        warn "The node isn't paired yet. Finish the setup wizard at $APP_URL, create a node for $DOMAIN, then run:"
        printf '\n      sudo glacier daemon --token <token from the node page>\n\n'
      fi
      ;;
  esac
  summary
}

main "$@"
