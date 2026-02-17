#!/bin/bash
# SatoshiStacks SSL Setup Script
# Run as root after DNS is configured
# Usage: bash setup-ssl.sh yourdomain.com

set -e  # Exit on error

# Check if domain provided
if [ -z "$1" ]; then
    echo "❌ Error: Domain name required"
    echo "   Usage: bash setup-ssl.sh yourdomain.com"
    exit 1
fi

DOMAIN=$1
EMAIL="admin@$DOMAIN"  # Change if needed

echo "🔐 Setting up SSL for $DOMAIN..."
echo ""

# Check if DNS is pointing to this server
echo "📡 Checking DNS configuration..."
SERVER_IP=$(curl -s ifconfig.me)
DOMAIN_IP=$(dig +short $DOMAIN | tail -1)

if [ "$SERVER_IP" != "$DOMAIN_IP" ]; then
    echo "⚠️  Warning: DNS might not be configured correctly"
    echo "   Server IP: $SERVER_IP"
    echo "   Domain IP: $DOMAIN_IP"
    echo ""
    read -p "Continue anyway? (y/n) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 1
    fi
fi

# Get SSL certificate from Let's Encrypt
echo "📜 Obtaining SSL certificate from Let's Encrypt..."
certbot --nginx \
    -d $DOMAIN \
    -d www.$DOMAIN \
    --non-interactive \
    --agree-tos \
    --email $EMAIL \
    --redirect

# Test auto-renewal
echo "🔄 Testing SSL certificate auto-renewal..."
certbot renew --dry-run

# Configure auto-renewal cron job
echo "⏰ Setting up auto-renewal cron job..."
(crontab -l 2>/dev/null; echo "0 3 * * * certbot renew --quiet") | crontab -

echo ""
echo "✅ SSL certificate installed successfully!"
echo ""
echo "📊 Certificate info:"
certbot certificates | grep -A 5 $DOMAIN || true
echo ""
echo "🎯 Your site should now be accessible at:"
echo "   https://$DOMAIN"
echo "   https://www.$DOMAIN"
echo ""
echo "🔄 Auto-renewal is configured (checks daily at 3 AM)"
echo ""
