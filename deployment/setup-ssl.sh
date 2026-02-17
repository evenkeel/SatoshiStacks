#!/bin/bash
# SatoshiStacks SSL Setup Script
# Run as root after DNS is configured
# Usage: bash setup-ssl.sh yourdomain.com

set -euo pipefail

# ─── Argument Validation ─────────────────────────────────────────────────────
if [ -z "${1:-}" ]; then
    echo "  ✗ Error: Domain name required"
    echo "  Usage: bash setup-ssl.sh yourdomain.com"
    exit 1
fi

DOMAIN="$1"
EMAIL="${2:-admin@$DOMAIN}"  # Optional second arg for email

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║  SatoshiStacks SSL Setup                 ║"
echo "╚══════════════════════════════════════════╝"
echo ""
echo "  Domain: $DOMAIN"
echo "  Email:  $EMAIL"
echo ""

# ─── Pre-flight checks ───────────────────────────────────────────────────────
if [ "$(id -u)" -ne 0 ]; then
    echo "  ✗ This script must be run as root"
    exit 1
fi

command -v certbot >/dev/null 2>&1 || { echo "  ✗ certbot not found. Run server-setup.sh first."; exit 1; }
command -v nginx   >/dev/null 2>&1 || { echo "  ✗ nginx not found. Run server-setup.sh first."; exit 1; }

# Verify nginx config is valid before we start
nginx -t 2>/dev/null || { echo "  ✗ Nginx config is invalid. Fix before requesting certificate."; exit 1; }

# ─── DNS Verification ────────────────────────────────────────────────────────
echo "[1/4] Checking DNS configuration..."
SERVER_IP=$(curl -sf ifconfig.me || curl -sf icanhazip.com || echo "unknown")
DOMAIN_IP=$(dig +short "$DOMAIN" | tail -1)

echo "  Server IP: $SERVER_IP"
echo "  Domain IP: $DOMAIN_IP"

if [ "$SERVER_IP" != "$DOMAIN_IP" ]; then
    echo ""
    echo "  ⚠️  Warning: DNS might not be configured correctly"
    echo "  ⚠️  Certificate request will likely fail if DNS doesn't point here"
    echo ""
    read -p "  Continue anyway? (y/N) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 1
    fi
else
    echo "  ✓ DNS correctly points to this server"
fi

# ─── Certificate Request ─────────────────────────────────────────────────────
echo ""
echo "[2/4] Obtaining SSL certificate from Let's Encrypt..."
certbot --nginx \
    -d "$DOMAIN" \
    -d "www.$DOMAIN" \
    --non-interactive \
    --agree-tos \
    --email "$EMAIL" \
    --redirect \
    --staple-ocsp

# ─── Enable HSTS ─────────────────────────────────────────────────────────────
echo "[3/4] Enabling HSTS header..."
SECURITY_CONF="/etc/nginx/conf.d/security-headers.conf"
if [ -f "$SECURITY_CONF" ]; then
    # Uncomment the HSTS line that harden.sh left commented
    sed -i 's|^# add_header Strict-Transport-Security|add_header Strict-Transport-Security|' "$SECURITY_CONF"

    if nginx -t 2>/dev/null; then
        systemctl reload nginx
        echo "  ✓ HSTS enabled (1 year, includeSubDomains)"
    else
        echo "  ⚠ Nginx config test failed after HSTS — reverting"
        sed -i 's|^add_header Strict-Transport-Security|# add_header Strict-Transport-Security|' "$SECURITY_CONF"
        systemctl reload nginx
    fi
else
    echo "  ⚠ security-headers.conf not found — run harden.sh first for HSTS"
fi

# ─── Auto-Renewal ────────────────────────────────────────────────────────────
echo "[4/4] Configuring auto-renewal..."

# Use systemd timer if available (preferred over cron), otherwise cron
if systemctl list-unit-files certbot.timer >/dev/null 2>&1; then
    systemctl enable certbot.timer
    systemctl start certbot.timer
    echo "  ✓ Certbot systemd timer enabled (auto-renewal twice daily)"
else
    # Idempotent cron — avoid duplicate entries
    CRON_JOB="0 3 * * * certbot renew --quiet --deploy-hook 'systemctl reload nginx'"
    (crontab -l 2>/dev/null | grep -v 'certbot renew' ; echo "$CRON_JOB") | crontab -
    echo "  ✓ Certbot cron job configured (daily at 3 AM, reloads nginx on renewal)"
fi

# Test renewal
echo ""
echo "  Testing auto-renewal..."
certbot renew --dry-run && echo "  ✓ Renewal test passed" || echo "  ⚠ Renewal test failed — check certbot logs"

# ─── Summary ──────────────────────────────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════╗"
echo "║  SSL Setup Complete                      ║"
echo "╚══════════════════════════════════════════╝"
echo ""
echo "Certificate info:"
certbot certificates 2>/dev/null | grep -A 5 "$DOMAIN" || true
echo ""
echo "Your site is now accessible at:"
echo "  https://$DOMAIN"
echo "  https://www.$DOMAIN"
echo ""
echo "Auto-renewal is configured and tested."
echo ""
echo "Verify HTTPS quality:"
echo "  https://www.ssllabs.com/ssltest/analyze.html?d=$DOMAIN"
echo ""
