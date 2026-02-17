#!/bin/bash
# SatoshiStacks Application Deployment Script
# Run as poker user after code is uploaded
# Usage: bash deploy-app.sh

set -e  # Exit on error

echo "🎰 Deploying SatoshiStacks..."
echo ""

# Check if running as poker user
if [ "$USER" != "poker" ]; then
    echo "❌ Error: This script must be run as poker user"
    echo "   Run: sudo -u poker bash deploy-app.sh"
    exit 1
fi

# Set variables
APP_DIR="/home/poker/satoshistacks"

# Navigate to app directory
cd $APP_DIR

# Install backend dependencies
echo "📦 Installing backend dependencies..."
cd packages/backend
npm install --production

# Install frontend dependencies (optional if serving static files)
echo "📦 Installing frontend dependencies..."
cd ../frontend
npm install --production

# Go back to root
cd $APP_DIR

# Initialize database if it doesn't exist
echo "💾 Checking database..."
if [ ! -f "packages/backend/db/satoshistacks.db" ]; then
    echo "📊 Database not found - will be created on first run"
fi

# Stop PM2 if already running
echo "🛑 Stopping existing PM2 processes..."
pm2 delete satoshistacks-backend || true

# Start backend with PM2
echo "🚀 Starting backend server..."
cd packages/backend
pm2 start server.js --name satoshistacks-backend --watch false

# Save PM2 configuration
echo "💾 Saving PM2 configuration..."
pm2 save

# Set up PM2 startup script (run on reboot)
echo "🔄 Setting up PM2 startup..."
pm2 startup | tail -1 | sudo bash || true

# Show PM2 status
echo ""
echo "📊 PM2 Status:"
pm2 status

# Show logs location
echo ""
echo "📝 Logs location:"
echo "  - PM2 logs: ~/.pm2/logs/"
echo "  - Backend logs: pm2 logs satoshistacks-backend"

echo ""
echo "✅ Application deployed successfully!"
echo ""
echo "🎯 Next steps:"
echo "  1. Configure Nginx"
echo "  2. Set up SSL certificate"
echo "  3. Test the application"
echo ""
