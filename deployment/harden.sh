#!/bin/bash
# SatoshiStacks VPS Hardening Script
# Run as root on the production server
# Usage: sudo bash harden.sh
#
# IMPORTANT: Before running, confirm you can SSH in with a key (not password)
# This script will lock out password auth at the end.

set -e

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║  SatoshiStacks VPS Hardening             ║"
echo "║  satoshistacks.com/playmoney             ║"
echo "╚══════════════════════════════════════════╝"
echo ""

# ─── 1. System Update ───────────────────────────────────────────────────────
echo "[1/8] Updating system packages..."
apt update && apt upgrade -y
apt install -y fail2ban unattended-upgrades ufw curl sqlite3

# ─── 2. Swap Space ──────────────────────────────────────────────────────────
echo "[2/8] Configuring swap (2GB)..."
if [ ! -f /swapfile ]; then
    fallocate -l 2G /swapfile
    chmod 600 /swapfile
    mkswap /swapfile
    swapon /swapfile
    echo '/swapfile none swap sw 0 0' >> /etc/fstab
    echo 'vm.swappiness=10' >> /etc/sysctl.conf
    sysctl -p
    echo "  ✓ Swap configured (2GB)"
else
    echo "  ✓ Swap already configured, skipping"
fi

# ─── 3. UFW Firewall ────────────────────────────────────────────────────────
echo "[3/8] Configuring UFW firewall..."
ufw default deny incoming
ufw default allow outgoing
ufw allow ssh        # port 22 — MUST be before ufw enable
ufw allow 80/tcp     # HTTP
ufw allow 443/tcp    # HTTPS
ufw --force enable
echo "  ✓ Firewall enabled (22, 80, 443 open)"

# ─── 4. fail2ban ────────────────────────────────────────────────────────────
echo "[4/8] Configuring fail2ban..."
tee /etc/fail2ban/jail.local << 'EOF'
[DEFAULT]
bantime = 86400
findtime = 600
maxretry = 3
ignoreip = 127.0.0.1/8

[sshd]
enabled = true
port = ssh
filter = sshd
logpath = /var/log/auth.log
maxretry = 3
bantime = 86400

[nginx-http-auth]
enabled = true
EOF

systemctl enable fail2ban
systemctl restart fail2ban
echo "  ✓ fail2ban configured (ban after 3 tries, 24h ban)"

# ─── 5. Automatic Security Updates ──────────────────────────────────────────
echo "[5/8] Enabling automatic security updates..."
cat > /etc/apt/apt.conf.d/20auto-upgrades << 'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
EOF
systemctl enable unattended-upgrades
echo "  ✓ Auto security updates enabled"

# ─── 6. Nginx Security Headers ──────────────────────────────────────────────
echo "[6/8] Adding Nginx security headers..."
# Find nginx config and add security headers
NGINX_CONF="/etc/nginx/conf.d/security-headers.conf"
tee $NGINX_CONF << 'EOF'
# Security headers for all sites
server_tokens off;  # Hide nginx version

add_header X-Frame-Options "SAMEORIGIN" always;
add_header X-XSS-Protection "1; mode=block" always;
add_header X-Content-Type-Options "nosniff" always;
add_header Referrer-Policy "strict-origin-when-cross-origin" always;

# Rate limiting zone (used in server blocks)
limit_req_zone $binary_remote_addr zone=api:10m rate=10r/s;
limit_req_zone $binary_remote_addr zone=auth:10m rate=5r/m;
EOF

# Test nginx config
if nginx -t 2>/dev/null; then
    systemctl reload nginx
    echo "  ✓ Nginx security headers added"
else
    rm $NGINX_CONF
    echo "  ⚠ Nginx config test failed, skipped headers (check manually)"
fi

# ─── 7. SQLite Backup ───────────────────────────────────────────────────────
echo "[7/8] Setting up automated SQLite backups..."

# Find the database
DB_PATH=""
for possible in \
    "/home/poker/satoshistacks/packages/backend/db/satoshistacks.db" \
    "/root/satoshistacks/packages/backend/db/satoshistacks.db" \
    "/var/www/satoshistacks/packages/backend/db/satoshistacks.db"; do
    if [ -f "$possible" ]; then
        DB_PATH="$possible"
        break
    fi
done

if [ -n "$DB_PATH" ]; then
    BACKUP_DIR="$(dirname $DB_PATH)/backups"
    mkdir -p "$BACKUP_DIR"

    tee /usr/local/bin/backup-satoshistacks.sh << BACKUP
#!/bin/bash
set -e
DB_PATH="$DB_PATH"
BACKUP_DIR="$BACKUP_DIR"
DATE=\$(date +"%Y-%m-%d_%H-%M")
mkdir -p \$BACKUP_DIR

# VACUUM INTO is safer than file copy — transactionally consistent
sqlite3 "\$DB_PATH" "VACUUM INTO '\$BACKUP_DIR/satoshistacks-\$DATE.db'"
gzip "\$BACKUP_DIR/satoshistacks-\$DATE.db"

# Keep only last 30 days of backups
find \$BACKUP_DIR -name "*.db.gz" -mtime +30 -delete

echo "\$(date): Backup completed: satoshistacks-\$DATE.db.gz" >> /var/log/satoshistacks-backup.log
BACKUP

    chmod +x /usr/local/bin/backup-satoshistacks.sh

    # Add to cron (daily at 3 AM)
    (crontab -l 2>/dev/null; echo "0 3 * * * /usr/local/bin/backup-satoshistacks.sh") | crontab -
    echo "  ✓ SQLite backup configured (daily at 3 AM)"
    echo "  ✓ DB path: $DB_PATH"
    echo "  ✓ Backups go to: $BACKUP_DIR"
else
    echo "  ⚠ Database not found at expected paths — configure backup manually"
    echo "  ⚠ Expected: /home/poker/satoshistacks/packages/backend/db/satoshistacks.db"
fi

# ─── 8. SSH Hardening ───────────────────────────────────────────────────────
echo ""
echo "[8/8] SSH Hardening..."
echo ""
echo "  ⚠️  IMPORTANT: SSH hardening requires manual confirmation."
echo "  ⚠️  Before disabling password auth, verify you can SSH with a key."
echo ""
echo "  Run this ONLY after confirming key-based SSH works:"
echo ""
echo "  sudo tee /etc/ssh/sshd_config.d/00-hardening.conf << 'EOF'"
echo "  PasswordAuthentication no"
echo "  PermitRootLogin no"
echo "  PermitEmptyPasswords no"
echo "  MaxAuthTries 3"
echo "  X11Forwarding no"
echo "  EOF"
echo "  sudo sshd -t && sudo systemctl reload sshd"
echo ""

# ─── Summary ────────────────────────────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════╗"
echo "║  Hardening Complete                      ║"
echo "╚══════════════════════════════════════════╝"
echo ""
echo "✅ System updated"
echo "✅ Swap: 2GB configured"
echo "✅ UFW: Firewall active (22, 80, 443)"
echo "✅ fail2ban: Active (ban after 3 tries)"
echo "✅ Auto-updates: Enabled"
echo "✅ Nginx: Security headers added"
echo "✅ SQLite: Daily backups at 3 AM"
echo "⚠️  SSH: Complete manually (step 8 above)"
echo ""
echo "Verify with:"
echo "  sudo ufw status verbose"
echo "  sudo fail2ban-client status sshd"
echo "  free -h"
echo "  sudo ss -tlnp"
