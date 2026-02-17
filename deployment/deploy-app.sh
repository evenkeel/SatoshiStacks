#!/bin/bash
# SatoshiStacks Application Deployment Script
# Run as root after server-setup.sh
# Usage: bash deploy-app.sh

set -e  # Exit on error

echo "Deploying SatoshiStacks..."
echo ""

APP_DIR="/opt/SatoshiStacks"

# Clone repo if not already present
if [ ! -d "$APP_DIR/.git" ]; then
    echo "Cloning repository..."
    cd /opt
    git clone https://github.com/evenkeel/SatoshiStacks.git
fi

# Install backend dependencies
echo "Installing backend dependencies..."
cd $APP_DIR/packages/backend
npm install --production

# Create .env if it doesn't exist
if [ ! -f ".env" ]; then
    echo "Creating .env file..."
    ADMIN_TOKEN=$(openssl rand -hex 32)
    cat > .env << EOF
PORT=3001
NODE_ENV=production
CORS_ORIGIN=https://satoshistacks.com,https://www.satoshistacks.com
ADMIN_TOKEN=$ADMIN_TOKEN
EOF
    echo "Generated ADMIN_TOKEN: $ADMIN_TOKEN"
    echo "Save this token — you'll need it for admin access."
fi

# Stop existing PM2 process if running
echo "Stopping existing PM2 processes..."
pm2 delete satoshistacks 2>/dev/null || true

# Start with PM2
echo "Starting application..."
pm2 start server.js --name satoshistacks
pm2 save

# Set up PM2 startup (auto-restart on reboot)
echo "Configuring PM2 startup..."
pm2 startup systemd -u root --hp /root 2>/dev/null || true
pm2 save

# Show status
echo ""
echo "PM2 Status:"
pm2 status

echo ""
echo "Application deployed!"
echo ""
echo "Next steps:"
echo "  1. Configure Nginx (see nginx-config.template)"
echo "  2. Upload coming-soon.html to /opt/coming-soon.html"
echo "  3. Set up DNS A records"
echo "  4. Run setup-ssl.sh for HTTPS"
echo ""
