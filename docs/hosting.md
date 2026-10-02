# Hosting

Two pieces, two places. The site builds from the public repository on Vercel at
`cometail.fun`. The worker runs on one small box: the keeper and the indexer as two
services, and only the indexer's read API reaches the internet, at `api.cometail.fun`,
behind Caddy with automatic HTTPS. The worker binds to loopback; the API allows only the
site's origin and rate-limits each client address.

## Site on Vercel

Project settings:
- Root Directory: `web` (keep "Include source files outside of the Root Directory" on; the
  workspace lockfile and `packages/client` live above it).
- Framework: Next.js. Build command: `next build --turbopack` (the package script). Install
  command: default (pnpm, from the root lockfile). Node: 22.x.
- Environment variables (Production and Preview):
  - `NEXT_PUBLIC_CLUSTER=devnet` (the header shows the Devnet badge for anything but mainnet)
  - `NEXT_PUBLIC_RPC_URL=https://devnet.helius-rpc.com/?api-key=...` a keyed devnet RPC;
    the public endpoint rate-limits browsers. The key is visible to browsers, so restrict it
    to the `cometail.fun` origin in the provider's dashboard.
  - `NEXT_PUBLIC_API_URL=https://api.cometail.fun`
  - the devnet addresses are the defaults in `web/src/lib/addresses.ts`; override with
    `NEXT_PUBLIC_PROTOCOL`, `NEXT_PUBLIC_PLAIN_CONFIG`, `NEXT_PUBLIC_STREAM_CONFIG_25/50/75`
    when they change.
- Domains: `cometail.fun` on the project (and `www.cometail.fun` redirecting to it if wanted).

DNS at the registrar:
- `cometail.fun`: the A record or CNAME Vercel shows for the domain in the project's domain settings.
- `www.cometail.fun` CNAME `cname.vercel-dns.com` (optional).
- `api.cometail.fun` A the box's public address.

## Worker on the box

Files in `deploy/`: the Caddyfile, two systemd template units (the instance name is the
service user), and the environment example. The checkout is reached through `/opt/cometail`
(a symlink to the service user's clone) and node through `/opt/cometail/node`, so no unit
names a home directory. The real environment file holds the RPC key and lives at
`/etc/cometail/worker.env`, root-owned and readable by the service user only, outside the
repository. The keeper key stays in `keys/devnet/` (ignored by git).

As root, once (Ubuntu 24.04), from a sudo shell of the service user so `$SUDO_USER` and
`$HOME` name that user and its clone:

```
# the checkout and node, by neutral paths
ln -sfn "$(getent passwd "$SUDO_USER" | cut -d: -f6)/cometail" /opt/cometail
ln -sfn "$(sudo -u "$SUDO_USER" -i bash -lc 'command -v node')" /opt/cometail/node
sudo -u "$SUDO_USER" mkdir -p /opt/cometail/.local

# the environment file: root-owned, readable by the service user only
mkdir -p /etc/cometail
install -m 640 -o root -g "$SUDO_USER" /opt/cometail/deploy/worker.env.example /etc/cometail/worker.env
# edit /etc/cometail/worker.env: COMETAIL_RPC_URL (the keyed devnet RPC)

# Caddy from its official repository
apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
apt-get update && apt-get install -y caddy
install -m 644 /opt/cometail/deploy/Caddyfile /etc/caddy/Caddyfile
mkdir -p /var/log/caddy && chown caddy:caddy /var/log/caddy
caddy validate --config /etc/caddy/Caddyfile
systemctl enable --now caddy
systemctl reload caddy

# the two worker services
install -m 644 /opt/cometail/deploy/cometail-keeper@.service /etc/systemd/system/cometail-keeper@.service
install -m 644 /opt/cometail/deploy/cometail-indexer@.service /etc/systemd/system/cometail-indexer@.service
systemctl daemon-reload
systemctl enable --now "cometail-indexer@$SUDO_USER" "cometail-keeper@$SUDO_USER"

# only ssh, http and https reach the box
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
ufw status verbose
```

Checks:

```
systemctl status caddy "cometail-indexer@$SUDO_USER" "cometail-keeper@$SUDO_USER" --no-pager
journalctl -u "cometail-indexer@$SUDO_USER" -n 20 --no-pager
curl -s https://api.cometail.fun/api/health
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8787/api/health   # reachable only on the box
```

Updating: `git pull` in the clone (the owner pushes; the box only pulls), then
`systemctl restart "cometail-indexer@$SUDO_USER" "cometail-keeper@$SUDO_USER"` as root. The Caddyfile reloads with
`systemctl reload caddy`.

## What stays private

The RPC key, the keeper key, the box's address and any account or path name of the box
never enter the repository. The API
publishes only what the chain already shows: vault snapshots, events, the Sky scan.
