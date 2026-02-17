#!/bin/bash
# SatoshiStacks Server Setup Script
# Run as root on fresh Ubuntu 24.04 VPS
# Usage: bash server-setup.sh

set -e  # Exit on error

echo "🚀 SatoshiStacks Server Setup Starting..."
echo ""

# Update system
echo "📦 Updating system packages..."
apt update && apt upgrade -y

# Install Node.js 20.x LTS
echo "📦 Installing Node.js 20.x..."
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs

# Verify Node.js installation
node -v
npm -v

# Install PM2 (process manager)
echo "📦 Installing PM2..."
npm install -g pm2

# Install Nginx (web server)
echo "📦 Installing Nginx..."
apt install -y nginx

# Install Certbot for SSL
echo "📦 Installing Certbot (Let's Encrypt SSL)..."
apt install -y certbot python3-certbot-nginx

# Install SQLite
echo "📦 Installing SQLite..."
apt install -y sqlite3

# Install fail2ban (brute force protection)
echo "📦 Installing fail2ban..."
apt install -y fail2ban
systemctl enable fail2ban
systemctl start fail2ban

# Create poker user (security - don't run as root)
echo "👤 Creating 'poker' user..."
if ! id -u poker > /dev/null 2>&1; then
    useradd -m -s /bin/bash poker
    echo "poker:$(openssl rand -base64 32)" | chpasswd  # Random password
fi

# Set up firewall (UFW)
echo "🔥 Configuring firewall..."
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw --force enable

# Enable automatic security updates
echo "🔐 Enabling automatic security updates..."
apt install -y unattended-upgrades
dpkg-reconfigure -plow unattended-upgrades

# Create application directory
echo "📁 Creating application directory..."
mkdir -p /home/poker/satoshistacks
chown poker:poker /home/poker/satoshistacks

echo ""
echo "✅ Server setup complete!"
echo ""
echo "📊 Installed:"
echo "  - Node.js $(node -v)"
echo "  - PM2 $(pm2 -v)"
echo "  - Nginx $(nginx -v 2>&1 | grep version)"
echo "  - Certbot $(certbot --version | head -1)"
echo ""
echo "🎯 Next steps:"
echo "  1. Upload SatoshiStacks code to /home/poker/satoshistacks"
echo "  2. Run deploy-app.sh as poker user"
echo "  3. Run setup-ssl.sh with your domain"
echo ""
