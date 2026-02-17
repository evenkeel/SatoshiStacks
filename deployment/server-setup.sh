#!/bin/bash
# SatoshiStacks Server Setup Script
# Run as root on fresh Ubuntu 24.04 VPS
# Usage: bash server-setup.sh

set -e  # Exit on error

echo "SatoshiStacks Server Setup Starting..."
echo ""

# Update system
echo "Updating system packages..."
apt update && apt upgrade -y

# Install Node.js 20.x LTS
echo "Installing Node.js 20.x..."
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs

# Verify Node.js installation
echo "Node.js $(node -v)"
echo "npm $(npm -v)"

# Install PM2 (process manager)
echo "Installing PM2..."
npm install -g pm2

# Install Nginx
echo "Installing Nginx..."
apt install -y nginx

# Install Certbot for SSL
echo "Installing Certbot..."
apt install -y certbot python3-certbot-nginx

# Install SQLite and build tools (needed for better-sqlite3)
echo "Installing SQLite and build tools..."
apt install -y sqlite3 build-essential python3

# Install fail2ban (brute force protection)
echo "Installing fail2ban..."
apt install -y fail2ban
systemctl enable fail2ban
systemctl start fail2ban

# Set up firewall (UFW)
echo "Configuring firewall..."
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw --force enable

# Create application directory
echo "Creating application directory..."
mkdir -p /opt/SatoshiStacks

echo ""
echo "Server setup complete!"
echo ""
echo "Installed:"
echo "  - Node.js $(node -v)"
echo "  - PM2 $(pm2 -v)"
echo "  - Nginx $(nginx -v 2>&1 | grep -oP 'nginx/\S+')"
echo "  - Certbot $(certbot --version 2>&1 | head -1)"
echo ""
echo "Next steps:"
echo "  1. Clone repo: cd /opt && git clone https://github.com/evenkeel/SatoshiStacks.git"
echo "  2. Run deploy-app.sh"
echo "  3. Configure Nginx with nginx-config.template"
echo "  4. Set up DNS, then run setup-ssl.sh"
echo ""
