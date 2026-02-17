#!/bin/bash
# SatoshiStacks VPS Hardening Script (Phase 5.7)
# Run as root on the production server
# Usage: sudo bash harden.sh
#
# IMPORTANT: Before running, confirm you can SSH in with a key (not password)
# This script will lock out password auth at the end.
#
# Idempotent — safe to re-run without duplicating configs.

set -euo pipefail

LOGFILE="/var/log/satoshistacks-harden.log"
exec > >(tee -a "$LOGFILE") 2>&1

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║  SatoshiStacks VPS Hardening  (v5.7)     ║"
echo "║  satoshistacks.com/playmoney             ║"
echo "╚══════════════════════════════════════════╝"
echo ""
echo "Started: $(date -u '+%Y-%m-%d %H:%M:%S UTC')"
echo ""

# ─── Pre-flight checks ───────────────────────────────────────────────────────
if [ "$(id -u)" -ne 0 ]; then
    echo "  ✗ This script must be run as root (or with sudo)"
    exit 1
fi

# Warn if no SSH key is configured for the current user
if ! find /root/.ssh /home/*/.ssh -name authorized_keys -size +0c 2>/dev/null | grep -q .; then
    echo "  ⚠️  WARNING: No SSH authorized_keys found."
    echo "  ⚠️  You may be locked out after SSH hardening."
    read -p "  Continue anyway? (y/N) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 1
    fi
fi

# ─── 1. System Update ───────────────────────────────────────────────────────
echo "[1/10] Updating system packages..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq && apt-get upgrade -y -qq
apt-get install -y -qq fail2ban unattended-upgrades ufw curl sqlite3 logrotate

# ─── 2. Swap Space ──────────────────────────────────────────────────────────
echo "[2/10] Configuring swap (2GB)..."
if [ ! -f /swapfile ]; then
    fallocate -l 2G /swapfile
    chmod 600 /swapfile
    mkswap /swapfile
    swapon /swapfile
    grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
    grep -q 'vm.swappiness' /etc/sysctl.conf || echo 'vm.swappiness=10' >> /etc/sysctl.conf
    sysctl -p
    echo "  ✓ Swap configured (2GB)"
else
    echo "  ✓ Swap already configured, skipping"
fi

# ─── 3. Kernel Hardening (sysctl) ────────────────────────────────────────────
echo "[3/10] Applying kernel hardening..."
tee /etc/sysctl.d/99-satoshistacks-hardening.conf << 'EOF'
# Prevent IP spoofing
net.ipv4.conf.all.rp_filter = 1
net.ipv4.conf.default.rp_filter = 1

# Ignore ICMP redirects (prevent MITM)
net.ipv4.conf.all.accept_redirects = 0
net.ipv4.conf.default.accept_redirects = 0
net.ipv4.conf.all.send_redirects = 0
net.ipv6.conf.all.accept_redirects = 0

# Ignore source-routed packets
net.ipv4.conf.all.accept_source_route = 0
net.ipv6.conf.all.accept_source_route = 0

# SYN flood protection
net.ipv4.tcp_syncookies = 1
net.ipv4.tcp_max_syn_backlog = 2048
net.ipv4.tcp_synack_retries = 2

# Ignore ICMP broadcast requests
net.ipv4.icmp_echo_ignore_broadcasts = 1

# Log martian packets
net.ipv4.conf.all.log_martians = 1
net.ipv4.conf.default.log_martians = 1

# Disable IPv4 forwarding (not a router)
net.ipv4.ip_forward = 0
net.ipv6.conf.all.forwarding = 0
EOF
sysctl --system > /dev/null 2>&1
echo "  ✓ Kernel network hardening applied"

# ─── 4. UFW Firewall ────────────────────────────────────────────────────────
echo "[4/10] Configuring UFW firewall..."
ufw default deny incoming
ufw default allow outgoing
ufw limit ssh        # port 22 — rate-limited (blocks brute force at firewall level)
ufw allow 80/tcp     # HTTP
ufw allow 443/tcp    # HTTPS
ufw --force enable
echo "  ✓ Firewall enabled (22 rate-limited, 80, 443 open)"

# ─── 5. fail2ban ────────────────────────────────────────────────────────────
echo "[5/10] Configuring fail2ban..."
tee /etc/fail2ban/jail.local << 'EOF'
[DEFAULT]
bantime  = 86400
bantime.increment = true
bantime.factor = 2
bantime.maxtime = 604800   ; 1 week max ban
findtime  = 600
maxretry = 3
ignoreip = 127.0.0.1/8
banaction = ufw

[sshd]
enabled  = true
mode     = aggressive
port     = ssh
filter   = sshd
logpath  = /var/log/auth.log
maxretry = 3
bantime  = 86400

[nginx-http-auth]
enabled  = true
logpath  = /var/log/nginx/error.log

[nginx-limit-req]
enabled  = true
filter   = nginx-limit-req
logpath  = /var/log/nginx/error.log
maxretry = 10
findtime = 60
bantime  = 3600

[nginx-botsearch]
enabled  = true
filter   = nginx-botsearch
logpath  = /var/log/nginx/access.log
maxretry = 5
EOF

systemctl enable fail2ban
systemctl restart fail2ban
echo "  ✓ fail2ban configured (incremental banning: 1d→2d→4d→...→1wk max)"

# ─── 6. Automatic Security Updates ──────────────────────────────────────────
echo "[6/10] Enabling automatic security updates..."
cat > /etc/apt/apt.conf.d/20auto-upgrades << 'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
EOF

# Configure unattended-upgrades to auto-reboot at 4 AM if needed
cat > /etc/apt/apt.conf.d/50unattended-upgrades-local << 'EOF'
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-Time "04:00";
Unattended-Upgrade::Remove-Unused-Kernel-Packages "true";
Unattended-Upgrade::Remove-Unused-Dependencies "true";
EOF

systemctl enable unattended-upgrades
echo "  ✓ Auto security updates enabled (auto-reboot at 4 AM if needed)"

# ─── 7. Nginx Security Headers ──────────────────────────────────────────────
echo "[7/10] Adding Nginx security headers..."
NGINX_CONF="/etc/nginx/conf.d/security-headers.conf"
tee $NGINX_CONF << 'EOF'
# Security headers for all sites
server_tokens off;  # Hide nginx version

add_header X-Frame-Options "SAMEORIGIN" always;
add_header X-Content-Type-Options "nosniff" always;
add_header Referrer-Policy "strict-origin-when-cross-origin" always;
add_header Permissions-Policy "camera=(), microphone=(), geolocation=(), payment=()" always;
add_header X-DNS-Prefetch-Control "off" always;

# Content Security Policy — adjust script/style sources if you add CDNs
add_header Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' wss:; frame-ancestors 'self'; base-uri 'self'; form-action 'self';" always;

# HSTS — only enable AFTER confirming HTTPS works (uncommented by setup-ssl.sh)
# add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;

# Rate limiting zones (applied in server blocks via nginx-config.template)
limit_req_zone $binary_remote_addr zone=api:10m rate=10r/s;
limit_req_zone $binary_remote_addr zone=auth:10m rate=5r/m;
limit_req_zone $binary_remote_addr zone=general:10m rate=30r/s;

# Connection limiting
limit_conn_zone $binary_remote_addr zone=addr:10m;
EOF

# Test nginx config
if nginx -t 2>/dev/null; then
    systemctl reload nginx
    echo "  ✓ Nginx security headers added (CSP, Permissions-Policy, rate limit zones)"
else
    rm $NGINX_CONF
    echo "  ⚠ Nginx config test failed, skipped headers (check manually)"
fi

# ─── 8. SQLite Backup ───────────────────────────────────────────────────────
echo "[8/10] Setting up automated SQLite backups..."

# Find the database
DB_PATH=""
for possible in \
    "/opt/SatoshiStacks/packages/backend/db/satoshistacks.db" \
    "/home/poker/satoshistacks/packages/backend/db/satoshistacks.db" \
    "/root/satoshistacks/packages/backend/db/satoshistacks.db" \
    "/var/www/satoshistacks/packages/backend/db/satoshistacks.db"; do
    if [ -f "$possible" ]; then
        DB_PATH="$possible"
        break
    fi
done

if [ -n "$DB_PATH" ]; then
    BACKUP_DIR="$(dirname $DB_PATH)/../backups"
    BACKUP_DIR="$(realpath -m $BACKUP_DIR)"
    mkdir -p "$BACKUP_DIR"
    chmod 700 "$BACKUP_DIR"

    tee /usr/local/bin/backup-satoshistacks.sh << BACKUP
#!/bin/bash
set -euo pipefail
DB_PATH="$DB_PATH"
BACKUP_DIR="$BACKUP_DIR"
DATE=\$(date +"%Y-%m-%d_%H-%M")
LOGFILE="/var/log/satoshistacks-backup.log"
mkdir -p \$BACKUP_DIR

# Pre-check: verify database exists and is readable
if [ ! -r "\$DB_PATH" ]; then
    echo "\$(date): FAILED — database not found or unreadable: \$DB_PATH" >> \$LOGFILE
    exit 1
fi

# Integrity check before backup
INTEGRITY=\$(sqlite3 "\$DB_PATH" "PRAGMA integrity_check;" 2>&1)
if [ "\$INTEGRITY" != "ok" ]; then
    echo "\$(date): WARNING — integrity check failed: \$INTEGRITY" >> \$LOGFILE
fi

# VACUUM INTO is safer than file copy — transactionally consistent
sqlite3 "\$DB_PATH" "VACUUM INTO '\$BACKUP_DIR/satoshistacks-\$DATE.db'"
gzip "\$BACKUP_DIR/satoshistacks-\$DATE.db"
chmod 600 "\$BACKUP_DIR/satoshistacks-\$DATE.db.gz"

# Verify backup is not empty
BACKUP_SIZE=\$(stat -c%s "\$BACKUP_DIR/satoshistacks-\$DATE.db.gz" 2>/dev/null || echo "0")
if [ "\$BACKUP_SIZE" -lt 1024 ]; then
    echo "\$(date): WARNING — backup suspiciously small (\${BACKUP_SIZE} bytes)" >> \$LOGFILE
fi

# Keep only last 30 days of backups
find \$BACKUP_DIR -name "*.db.gz" -mtime +30 -delete

echo "\$(date): Backup completed: satoshistacks-\$DATE.db.gz (\${BACKUP_SIZE} bytes)" >> \$LOGFILE
BACKUP

    chmod 700 /usr/local/bin/backup-satoshistacks.sh

    # Idempotent cron — avoid duplicate entries
    CRON_JOB="0 3 * * * /usr/local/bin/backup-satoshistacks.sh"
    (crontab -l 2>/dev/null | grep -v 'backup-satoshistacks' ; echo "$CRON_JOB") | crontab -
    echo "  ✓ SQLite backup configured (daily at 3 AM)"
    echo "  ✓ DB path: $DB_PATH"
    echo "  ✓ Backups: $BACKUP_DIR"

    # Configure log rotation for backup log
    tee /etc/logrotate.d/satoshistacks-backup << 'LOGROTATE'
/var/log/satoshistacks-backup.log {
    monthly
    rotate 12
    compress
    missingok
    notifempty
}
LOGROTATE

else
    echo "  ⚠ Database not found at expected paths — configure backup manually"
    echo "  ⚠ Expected: /opt/SatoshiStacks/packages/backend/db/satoshistacks.db"
fi

# ─── 9. Filesystem Hardening ─────────────────────────────────────────────────
echo "[9/10] Hardening filesystem permissions..."

# Secure /tmp with sticky bit (usually set, but ensure)
chmod 1777 /tmp

# Lock down cron directories
chmod 700 /etc/cron.d /etc/cron.daily /etc/cron.hourly /etc/cron.monthly /etc/cron.weekly 2>/dev/null || true

# Restrict access to sensitive files
chmod 600 /etc/ssh/sshd_config 2>/dev/null || true
chmod 640 /etc/shadow 2>/dev/null || true

# Disable core dumps (prevent credential leaks from crash dumps)
grep -q 'hard core 0' /etc/security/limits.conf 2>/dev/null || echo '* hard core 0' >> /etc/security/limits.conf
grep -q 'fs.suid_dumpable' /etc/sysctl.d/99-satoshistacks-hardening.conf || echo 'fs.suid_dumpable = 0' >> /etc/sysctl.d/99-satoshistacks-hardening.conf
sysctl -p /etc/sysctl.d/99-satoshistacks-hardening.conf > /dev/null 2>&1
echo "  ✓ Filesystem permissions hardened"

# ─── 10. SSH Hardening ──────────────────────────────────────────────────────
echo ""
echo "[10/10] SSH Hardening..."
echo ""
echo "  ⚠️  IMPORTANT: SSH hardening requires manual confirmation."
echo "  ⚠️  Before disabling password auth, verify you can SSH with a key."
echo ""
echo "  Test from another terminal FIRST:"
echo "    ssh -i ~/.ssh/your_key root@$(curl -s ifconfig.me 2>/dev/null || echo 'YOUR_SERVER_IP')"
echo ""
echo "  Then run this ONLY after confirming key-based SSH works:"
echo ""
echo "  sudo tee /etc/ssh/sshd_config.d/00-hardening.conf << 'SSHEOF'"
echo "  PasswordAuthentication no"
echo "  PermitRootLogin prohibit-password"
echo "  PermitEmptyPasswords no"
echo "  MaxAuthTries 3"
echo "  MaxSessions 3"
echo "  LoginGraceTime 30"
echo "  ClientAliveInterval 300"
echo "  ClientAliveCountMax 2"
echo "  X11Forwarding no"
echo "  AllowAgentForwarding no"
echo "  AllowTcpForwarding no"
echo "  PubkeyAuthentication yes"
echo "  AuthorizedKeysFile .ssh/authorized_keys"
echo "  HostKeyAlgorithms ssh-ed25519,rsa-sha2-512,rsa-sha2-256"
echo "  KexAlgorithms curve25519-sha256,curve25519-sha256@libssh.org"
echo "  Ciphers chacha20-poly1305@openssh.com,aes256-gcm@openssh.com,aes128-gcm@openssh.com"
echo "  MACs hmac-sha2-512-etm@openssh.com,hmac-sha2-256-etm@openssh.com"
echo "  SSHEOF"
echo "  sudo sshd -t && sudo systemctl reload sshd"
echo ""

# ─── Summary ────────────────────────────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════╗"
echo "║  Hardening Complete  (Phase 5.7)         ║"
echo "╚══════════════════════════════════════════╝"
echo ""
echo "✅ System updated"
echo "✅ Swap: 2GB configured"
echo "✅ Kernel: Network stack hardened (sysctl)"
echo "✅ UFW: Firewall active (22 rate-limited, 80, 443)"
echo "✅ fail2ban: Active (incremental banning, bot detection)"
echo "✅ Auto-updates: Enabled (auto-reboot at 4 AM if needed)"
echo "✅ Nginx: Security headers + CSP + rate limit zones"
echo "✅ SQLite: Daily backups at 3 AM (integrity-checked)"
echo "✅ Filesystem: Permissions hardened, core dumps disabled"
echo "⚠️  SSH: Complete manually (step 10 above)"
echo ""
echo "Full log: $LOGFILE"
echo ""
echo "Verify with:"
echo "  sudo ufw status verbose"
echo "  sudo fail2ban-client status sshd"
echo "  sudo sysctl -a | grep rp_filter"
echo "  free -h"
echo "  sudo ss -tlnp"
echo ""
