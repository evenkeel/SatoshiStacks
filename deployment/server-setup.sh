#!/bin/bash
# SatoshiStacks Server Setup Script
# Run as root on fresh Ubuntu 24.04 VPS
# Usage: bash server-setup.sh

set -euo pipefail

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║  SatoshiStacks Server Setup              ║"
echo "╚══════════════════════════════════════════╝"
echo ""

# ─── Pre-flight checks ───────────────────────────────────────────────────────
if [ "$(id -u)" -ne 0 ]; then
    echo "  ✗ This script must be run as root"
    exit 1
fi

export DEBIAN_FRONTEND=noninteractive

# ─── 1. System Update ───────────────────────────────────────────────────────
echo "[1/8] Updating system packages..."
apt-get update -qq && apt-get upgrade -y -qq

# ─── 2. Node.js 20.x LTS ────────────────────────────────────────────────────
echo "[2/8] Installing Node.js 20.x..."
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y -qq nodejs

echo "  ✓ Node.js $(node -v)"
echo "  ✓ npm $(npm -v)"

# ─── 3. PM2 Process Manager ─────────────────────────────────────────────────
echo "[3/8] Installing PM2..."
npm install -g pm2

# ─── 4. Nginx ────────────────────────────────────────────────────────────────
echo "[4/8] Installing Nginx..."
apt-get install -y -qq nginx

# Remove default site to avoid conflicts
rm -f /etc/nginx/sites-enabled/default

# ─── 5. Certbot ──────────────────────────────────────────────────────────────
echo "[5/8] Installing Certbot..."
apt-get install -y -qq certbot python3-certbot-nginx

# ─── 6. SQLite & Build Tools ─────────────────────────────────────────────────
echo "[6/8] Installing SQLite and build tools..."
apt-get install -y -qq sqlite3 build-essential python3

# ─── 7. Security Baseline ────────────────────────────────────────────────────
echo "[7/8] Setting up security baseline..."

# fail2ban
apt-get install -y -qq fail2ban
systemctl enable fail2ban
systemctl start fail2ban

# UFW — minimal rules (harden.sh will tighten further)
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw --force enable

echo "  ✓ fail2ban active"
echo "  ✓ UFW enabled (SSH + Nginx)"

# ─── 8. Application Directory ────────────────────────────────────────────────
echo "[8/8] Creating application directory..."
mkdir -p /opt/SatoshiStacks
chmod 755 /opt/SatoshiStacks

# ─── Summary ─────────────────────────────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════╗"
echo "║  Server Setup Complete                   ║"
echo "╚══════════════════════════════════════════╝"
echo ""
echo "Installed:"
echo "  - Node.js $(node -v)"
echo "  - PM2 $(pm2 -v 2>/dev/null || echo 'installed')"
echo "  - Nginx $(nginx -v 2>&1 | grep -oP 'nginx/\S+' || echo 'installed')"
echo "  - Certbot $(certbot --version 2>&1 | head -1)"
echo "  - SQLite $(sqlite3 --version | cut -d' ' -f1)"
echo "  - fail2ban + UFW"
echo ""
echo "Next steps:"
echo "  1. Clone repo: cd /opt && git clone https://github.com/evenkeel/SatoshiStacks.git"
echo "  2. bash /opt/SatoshiStacks/deployment/deploy-app.sh"
echo "  3. bash /opt/SatoshiStacks/deployment/harden.sh"
echo "  4. Set up DNS A records → $(curl -s ifconfig.me 2>/dev/null || echo 'YOUR_SERVER_IP')"
echo "  5. bash /opt/SatoshiStacks/deployment/setup-ssl.sh yourdomain.com"
echo ""
