#!/bin/bash
# SatoshiStacks Application Deployment Script
# Run as root after server-setup.sh
# Usage: bash deploy-app.sh

set -euo pipefail

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║  SatoshiStacks Deploy                    ║"
echo "╚══════════════════════════════════════════╝"
echo ""

APP_DIR="/opt/SatoshiStacks"
BACKEND_DIR="$APP_DIR/packages/backend"

# ─── Pre-flight checks ───────────────────────────────────────────────────────
if [ "$(id -u)" -ne 0 ]; then
    echo "  ✗ This script must be run as root"
    exit 1
fi

command -v node >/dev/null 2>&1 || { echo "  ✗ Node.js not found. Run server-setup.sh first."; exit 1; }
command -v pm2  >/dev/null 2>&1 || { echo "  ✗ PM2 not found. Run server-setup.sh first."; exit 1; }

# ─── 1. Clone Repository ─────────────────────────────────────────────────────
if [ ! -d "$APP_DIR/.git" ]; then
    echo "[1/5] Cloning repository..."
    cd /opt
    git clone https://github.com/evenkeel/SatoshiStacks.git
else
    echo "[1/5] Repository already present, pulling latest..."
    cd "$APP_DIR"
    git pull --ff-only || echo "  ⚠ Pull failed — check for local changes"
fi

# ─── 2. Install Dependencies ─────────────────────────────────────────────────
echo "[2/5] Installing backend dependencies..."
cd "$BACKEND_DIR"
npm install --production

# ─── 3. Environment Configuration ────────────────────────────────────────────
echo "[3/5] Configuring environment..."
if [ ! -f "$BACKEND_DIR/.env" ]; then
    ADMIN_TOKEN=$(openssl rand -hex 32)
    cat > "$BACKEND_DIR/.env" << EOF
PORT=3001
NODE_ENV=production
CORS_ORIGIN=https://satoshistacks.com,https://www.satoshistacks.com
ADMIN_TOKEN=$ADMIN_TOKEN
EOF
    chmod 600 "$BACKEND_DIR/.env"
    echo "  ✓ .env created"
    echo ""
    echo "  ╔═══════════════════════════════════════════════════════════════════════╗"
    echo "  ║  ADMIN_TOKEN: $ADMIN_TOKEN"
    echo "  ║  Save this token — you'll need it for admin access.                  ║"
    echo "  ╚═══════════════════════════════════════════════════════════════════════╝"
    echo ""
else
    chmod 600 "$BACKEND_DIR/.env"
    echo "  ✓ .env already exists (permissions secured)"
fi

# ─── 4. Start Application ────────────────────────────────────────────────────
echo "[4/5] Starting application with PM2..."
pm2 delete satoshistacks 2>/dev/null || true

cd "$BACKEND_DIR"
pm2 start server.js \
    --name satoshistacks \
    --max-memory-restart 512M \
    --exp-backoff-restart-delay=100

pm2 save

# ─── 5. PM2 Startup ──────────────────────────────────────────────────────────
echo "[5/5] Configuring auto-restart on reboot..."
pm2 startup systemd -u root --hp /root 2>/dev/null || true
pm2 save

# ─── Health Check ─────────────────────────────────────────────────────────────
echo ""
echo "Waiting for app to start..."
sleep 3

if curl -sf http://localhost:3001/health > /dev/null 2>&1; then
    echo "  ✓ Health check passed (http://localhost:3001/health)"
else
    echo "  ⚠ Health check failed — check: pm2 logs satoshistacks"
fi

# ─── Summary ──────────────────────────────────────────────────────────────────
echo ""
pm2 status
echo ""
echo "╔══════════════════════════════════════════╗"
echo "║  Deployment Complete                     ║"
echo "╚══════════════════════════════════════════╝"
echo ""
echo "Next steps:"
echo "  1. Configure Nginx (see nginx-config.template)"
echo "  2. Upload coming-soon.html to /opt/coming-soon.html"
echo "  3. Set up DNS A records"
echo "  4. bash setup-ssl.sh yourdomain.com"
echo ""
echo "Useful commands:"
echo "  pm2 logs satoshistacks     # View app logs"
echo "  pm2 monit                  # Live monitoring"
echo "  pm2 restart satoshistacks  # Restart app"
echo ""
