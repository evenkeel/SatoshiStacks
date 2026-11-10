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
[November 10 deployment record](../DEPLOYMENT-2026-11-10.md) for the current
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
# Location
ls -lh /opt/SatoshiStacks/packages/backend/db/

# Query
sqlite3 /opt/SatoshiStacks/packages/backend/db/satoshistacks.db

# Backups (automated daily at 3 AM)
ls -lh /opt/SatoshiStacks/packages/backend/backups/

# Manual backup
/usr/local/bin/backup-satoshistacks.sh
```

---

## Security

**Active (Phase 5.7 hardening applied):**
- SSH key-only auth (password login disabled, strong ciphers, ed25519/curve25519)
- UFW firewall (port 22 rate-limited, 80 and 443 open, all else denied)
- fail2ban with incremental banning (1d → 2d → 4d → 1wk max)
- Kernel network hardening (IP spoofing, SYN flood, ICMP redirect protection)
- Nginx security headers (CSP, X-Frame-Options, X-Content-Type-Options, Permissions-Policy)
- Nginx rate limiting (API: 10r/s, auth: 5r/m, general: 30r/s)
- Let's Encrypt SSL with HSTS and auto-renewal
- Automated SQLite backups (daily at 3 AM, integrity-checked, 30-day retention)
- Automatic security updates with auto-reboot at 4 AM if needed
- Core dumps disabled, filesystem permissions hardened
- HTTP automatically redirects to HTTPS
- Common exploit paths blocked (.git, .env, wp-admin, phpmyadmin, etc.)

