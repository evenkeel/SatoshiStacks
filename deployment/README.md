# SatoshiStacks Deployment Guide

**How the production site is deployed and maintained.**

---

## Current Setup

| Component       | Detail                                      |
|-----------------|---------------------------------------------|
| **VPS**         | Hetzner Cloud CPX11 (~$5/month)             |
| **IP**          | (see Hetzner dashboard)                     |
| **OS**          | Ubuntu 24.04                                |
| **Domain**      | satoshistacks.com (Cloudflare DNS)          |
| **SSL**         | Let's Encrypt (auto-renews)                 |
| **App path**    | `/opt/SatoshiStacks/`                       |
| **Process mgr** | PM2 (process name: `satoshistacks`)         |
| **Web server**  | Nginx reverse proxy                         |
| **Auth**        | SSH key (ed25519)                           |

### URL Routing

| URL                                | Serves                          |
|------------------------------------|---------------------------------|
| `satoshistacks.com/`               | Coming Soon landing page        |
| `satoshistacks.com/station100`      | Poker table (effective demo/real-sats mode)    |
| `satoshistacks.com/api/*`          | Backend API                     |
| `satoshistacks.com/socket.io/*`    | WebSocket connections           |
| `satoshistacks.com/health`         | Health check endpoint           |

---

## Fresh Deployment (from scratch)

### 1. Provision VPS

- Hetzner Cloud > Create Server
- **Image:** Ubuntu 24.04
- **Type:** CPX11 (Shared vCPU, Ashburn VA)
- **Auth:** SSH key (ed25519)

### 2. Run Server Setup

```bash
ssh root@YOUR_VPS_IP
# Upload and run:
bash server-setup.sh
```

This installs Node.js 24, Nginx, PM2, Certbot, SQLite, fail2ban, and UFW firewall.

### 3. Deploy Application

```bash
# Clone repo on VPS
cd /opt
git clone https://github.com/evenkeel/SatoshiStacks.git
cd SatoshiStacks/packages/backend
npm ci --omit=dev

# Create .env
cat > .env << 'EOF'
PORT=3001
NODE_ENV=production
CORS_ORIGIN=https://satoshistacks.com,https://www.satoshistacks.com
ADMIN_TOKEN=<generate-with-openssl-rand-hex-32>
EOF

# Start with PM2
pm2 start server.js --name satoshistacks
pm2 save
pm2 startup
```

### 4. Configure Nginx

```bash
# Copy template and edit domain
cp nginx-config.template /etc/nginx/sites-available/satoshistacks
# Edit: replace DOMAIN_NAME with satoshistacks.com

# Upload Coming Soon page
cp /path/to/coming-soon.html /opt/coming-soon.html

# Enable site
ln -sf /etc/nginx/sites-available/satoshistacks /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx
```

### 5. Configure DNS (Cloudflare)

Add A records (DNS only / grey cloud):
```
@    A    YOUR_VPS_IP
www  A    YOUR_VPS_IP
```

### 6. Set Up SSL

```bash
bash setup-ssl.sh satoshistacks.com
```

---

## Common Operations

### Deploy Code Updates

The live demo runs an immutable release under `/opt/satoshistacks-releases/`,
not the retained `/opt/SatoshiStacks` checkout. A GitHub push updates the pull
request and runs CI; it does **not** deploy the public site. Pulling the retained
checkout alone also does not change the running release.

```bash
ssh satoshistacks
cat /opt/satoshistacks-releases/current-release.json
pm2 describe satoshistacks
curl -fsS http://127.0.0.1:3001/api/tables
```

Prepare a new release from the exact tested commit, install its locked
dependencies using the configured Node 24 runtime, and run the tests before
copying the live `.env` into place. The test suite must be isolated from the
live deployment configuration and use its in-memory databases and mocked
payments. Keep the running release online during preparation.

Before switching, verify there are no active players or hands; back up the demo
SQLite database with SQLite's backup API, the current-release manifest, and
the PM2 configuration. Point PM2's script, working directory, and interpreter
to the new release, preserve the existing demo database, and explicitly retain
disabled real money, deposits, and withdrawals. Verify health and the actual
public HTML/assets before saving PM2 and updating the manifest. Roll back to
the prior release if startup or verification fails.

The original funded database stays separate from the demo database. See the
[November 16 deployment record](../DEPLOYMENT-2026-11-16.md) for the current
release and rollback locations.

### View Logs

```bash
pm2 logs satoshistacks          # Application logs
pm2 logs satoshistacks --lines 100  # Last 100 lines
tail -f /var/log/nginx/error.log    # Nginx errors
```

### Restart Services

```bash
pm2 restart satoshistacks       # Restart app
systemctl restart nginx          # Restart Nginx
```

### Check Status

```bash
pm2 status                       # App status
systemctl status nginx           # Nginx status
curl http://localhost:3001/health # Health check
```

### Update Coming Soon Page

```bash
# Edit /opt/coming-soon.html on VPS
# No restart needed — Nginx serves it directly
```

---

## Troubleshooting

### Site Won't Load

```bash
# Check DNS
dig satoshistacks.com

# Check Nginx
nginx -t
systemctl status nginx
journalctl -u nginx -n 50

# Check app
pm2 status
pm2 logs satoshistacks --lines 50
```

### WebSocket Issues

```bash
# Verify socket.io proxy in Nginx config has:
#   proxy_http_version 1.1;
#   proxy_set_header Upgrade $http_upgrade;
#   proxy_set_header Connection "upgrade";
```

### SSL Certificate Issues

```bash
certbot certificates              # Check cert status
certbot renew --dry-run           # Test renewal
certbot --nginx -d satoshistacks.com -d www.satoshistacks.com  # Re-issue
```

### Database

```bash
# Live database (path comes from SATOSHISTACKS_DB_PATH in the PM2 config)
ls -lh /var/lib/satoshistacks/demo/

# Query (read-only)
sqlite3 "file:/var/lib/satoshistacks/demo/satoshistacks.db?mode=ro"

# Nightly backups (03:00 UTC, /etc/cron.d/satoshistacks-backup) and their log
ls -lh /var/backups/satoshistacks/nightly/
tail /var/log/satoshistacks-backup.log

# Manual backup
/usr/local/bin/backup-satoshistacks.sh
```

The job backs up every database under `/var/lib/satoshistacks/<name>/` and logs
`FAILED` (exit 1) if the database the running app uses is not one of them. A
database kept elsewhere must be listed in `EXTRA_DB_PATHS` in the cron file.
Backups stay on this server; copy them off the box before holding player funds.
The original May 2026 mainnet-test database is preserved byte-for-byte in
`/var/backups/satoshistacks/legacy-funded-db-raw-20261118T231100Z/`.

---

## Security

Checked on the live server and from the public internet on 2026-11-18, after the
fixes made that day. Earlier versions of this list described what the setup
scripts intend, not what was running, and several items were wrong. Re-check
before relying on any line.

**Verified working:**
- SSH: key-only (password and keyboard-interactive login off), root login by key, one authorized key
- UFW firewall: default deny; 22 rate-limited, 80 and 443 open. The app port (3001) is not reachable from the internet
- fail2ban: active with four jails (sshd and three nginx jails); sshd bans are happening
- Automatic security updates: enabled and running daily, with auto-reboot at 04:00 when an update needs it
- TLS: Let's Encrypt certificate with the renewal timer active; TLS 1.0/1.1 refused; HTTP redirects to HTTPS
- The app runs as the unprivileged `satoshistacks` user (PM2 itself still runs as root and starts it with `uid`/`gid`). That user cannot read the old checkout, its secrets, the backups, or root's SSH keys, and cannot modify its own code
- Nginx rate limits are applied: API 10 requests/second (burst 20), pages and assets 30/second (burst 50; 200 for static assets). Excess requests get 429. Socket.IO and `/health` are not limited. Sign-in has its own limit in the app
- `/.env`, `/.git/...` and common exploit-probe paths return 404
- The landing page is served with HSTS, X-Frame-Options, nosniff, Referrer-Policy and Permissions-Policy. App pages carry HSTS and a Content-Security-Policy set by the app
- The old checkout (`/opt/SatoshiStacks`) and `/var/backups/satoshistacks` are root-only
- No spend-capable LND macaroon is on the server (deleted 2026-11-18). A read-only one remains in `/opt/SatoshiStacks/secrets/`
- Admin API returns 401 without the token; the token is 64 characters
- Nightly SQLite backups at 03:00 UTC, integrity-checked, 30-day retention, same server only

**Deliberately not done:**
- The landing page has no Content-Security-Policy. It uses an inline script, Google Fonts and a form service, so a policy would have to allow all three and would break silently when the page changes
- Nginx's web root is still `/opt`, because the landing page is deployed by moving files there. Nothing secret under `/opt` is readable by Nginx's worker user any more

**Still open:**
- Backups are not copied off the server
- The deleted macaroon file is gone from this server, but LND would still honor a copy if one exists elsewhere. Bake a fresh one for launch, and revoke the old one on the node if it may have been copied
- Restart after a server reboot has not been tested since the app moved to its own user (the PM2 process list is saved with the new user)
- `nginx-config.template` does not match production; `nginx-live.conf` is a copy of what runs

**When deploying a release:** the PM2 config must keep `"uid": "satoshistacks"` and
`"gid": "satoshistacks"` (start from the newest `new.config.json` under
`/var/backups/satoshistacks/`). Copy the previous release's `.env` with `cp -p` so
it stays `root:satoshistacks` mode 640; a root-only `.env` stops the app from
starting. The database directory must stay owned by `satoshistacks`.

