# SatoshiStacks Deployment Guide

**Complete deployment package for getting poker site live**

---

## 📦 What's Included

1. **DEPLOYMENT-DAY-1-CHECKLIST.md** - Complete step-by-step guide
2. **server-setup.sh** - Initial VPS configuration
3. **deploy-app.sh** - Application deployment
4. **setup-ssl.sh** - SSL certificate setup
5. **nginx-config.template** - Nginx configuration

---

## 🚀 Quick Start

### Allen's Steps (30 minutes)

1. **Sign up for Hetzner VPS:**
   - Go to https://www.hetzner.com/cloud
   - Create account
   - Create new server:
     - **Image:** Ubuntu 24.04
     - **Type:** CX22 (€3.79/month)
     - **Location:** US or Europe
   - **SAVE:** IP address + root password

2. **Configure DNS:**
   - Log into domain registrar
   - Add A records:
     ```
     @    →  [VPS_IP_ADDRESS]
     www  →  [VPS_IP_ADDRESS]
     ```

3. **Send Noah:**
   - VPS IP address
   - Root password
   - Domain name

---

### Noah's Steps (2 hours)

#### 1. Connect to Server
```bash
ssh root@[VPS_IP_ADDRESS]
# Enter password when prompted
```

#### 2. Upload Deployment Scripts
```bash
# On local machine
scp -r deployment root@[VPS_IP_ADDRESS]:/root/
```

#### 3. Run Server Setup
```bash
# On VPS
cd /root/deployment
chmod +x *.sh
bash server-setup.sh
```

#### 4. Upload Application Code
```bash
# On local machine
cd /Users/noah/Noah/projects/satoshistacks
tar -czf satoshistacks.tar.gz packages/
scp satoshistacks.tar.gz poker@[VPS_IP_ADDRESS]:/home/poker/

# On VPS (as poker user)
ssh poker@[VPS_IP_ADDRESS]
cd /home/poker
tar -xzf satoshistacks.tar.gz
mv packages satoshistacks/
```

#### 5. Deploy Application
```bash
# On VPS (as poker user)
cd /root/deployment
bash deploy-app.sh
```

#### 6. Configure Nginx
```bash
# On VPS (as root)
cd /root/deployment

# Replace DOMAIN_NAME in template
sed "s/DOMAIN_NAME/[yourdomain.com]/g" nginx-config.template > /etc/nginx/sites-available/satoshistacks

# Enable site
ln -s /etc/nginx/sites-available/satoshistacks /etc/nginx/sites-enabled/
rm /etc/nginx/sites-enabled/default  # Remove default site

# Test configuration
nginx -t

# Restart Nginx
systemctl restart nginx
```

#### 7. Set Up SSL
```bash
# On VPS (as root)
cd /root/deployment
bash setup-ssl.sh [yourdomain.com]
```

#### 8. Verify Deployment
```bash
# Check backend is running
pm2 status

# Check Nginx is running
systemctl status nginx

# View logs
pm2 logs satoshistacks-backend
```

---

## ✅ Verification Checklist

After deployment, verify:

- [ ] https://yourdomain.com loads
- [ ] Poker table appears
- [ ] Can join game in 2+ tabs
- [ ] Cards deal, game progresses
- [ ] Hand completes successfully
- [ ] https://yourdomain.com/admin loads
- [ ] Admin dashboard shows stats
- [ ] No console errors

---

## 🔧 Troubleshooting

### Site Won't Load

**Check DNS:**
```bash
dig yourdomain.com
# Should show your VPS IP
```

**Check Nginx:**
```bash
sudo systemctl status nginx
sudo nginx -t  # Test configuration
sudo journalctl -u nginx -n 50  # View logs
```

**Check Backend:**
```bash
pm2 status
pm2 logs satoshistacks-backend
```

### SSL Certificate Issues

**Re-run Certbot:**
```bash
sudo certbot --nginx -d yourdomain.com -d www.yourdomain.com
```

**Check Certificate:**
```bash
sudo certbot certificates
```

### Game Won't Start

**Check Backend Logs:**
```bash
pm2 logs satoshistacks-backend --lines 100
```

**Check Database:**
```bash
ls -lh /home/poker/satoshistacks/packages/backend/db/
```

**Restart Backend:**
```bash
pm2 restart satoshistacks-backend
```

### Performance Issues

**Check Server Resources:**
```bash
htop  # Install with: apt install htop
df -h  # Disk space
free -h  # Memory
```

**Optimize PM2:**
```bash
pm2 restart satoshistacks-backend --max-memory-restart 200M
```

---

## 📊 Monitoring

### Server Health
```bash
# PM2 monitoring
pm2 monit

# System resources
htop

# Disk usage
df -h

# Memory usage
free -h
```

### Application Logs
```bash
# Backend logs
pm2 logs satoshistacks-backend

# Nginx access logs
sudo tail -f /var/log/nginx/access.log

# Nginx error logs
sudo tail -f /var/log/nginx/error.log
```

### Database
```bash
# Database size
ls -lh /home/poker/satoshistacks/packages/backend/db/

# Query database
sqlite3 /home/poker/satoshistacks/packages/backend/db/satoshistacks.db
```

---

## 🔐 Security

### Disable Root Login
```bash
# Edit SSH config
sudo nano /etc/ssh/sshd_config

# Change:
PermitRootLogin no

# Restart SSH
sudo systemctl restart sshd
```

### Set Up SSH Keys
```bash
# On local machine, generate key
ssh-keygen -t ed25519

# Copy to server
ssh-copy-id poker@[VPS_IP_ADDRESS]

# Disable password authentication
sudo nano /etc/ssh/sshd_config
# Change:
PasswordAuthentication no
```

### Configure Fail2Ban
```bash
# Check status
sudo systemctl status fail2ban

# View banned IPs
sudo fail2ban-client status sshd
```

---

## 🔄 Updates & Maintenance

### Update Application Code
```bash
# On local machine
cd /Users/noah/Noah/projects/satoshistacks
tar -czf satoshistacks-update.tar.gz packages/
scp satoshistacks-update.tar.gz poker@[VPS_IP_ADDRESS]:/home/poker/

# On VPS (as poker user)
cd /home/poker/satoshistacks
pm2 stop satoshistacks-backend
tar -xzf ../satoshistacks-update.tar.gz
cd packages/backend && npm install
pm2 restart satoshistacks-backend
```

### Update System Packages
```bash
sudo apt update && sudo apt upgrade -y
```

### Backup Database
```bash
# Manual backup
cd /home/poker/satoshistacks/packages/backend/db
cp satoshistacks.db satoshistacks-backup-$(date +%Y%m%d).db

# Automated daily backups (add to cron)
0 2 * * * cp /home/poker/satoshistacks/packages/backend/db/satoshistacks.db /home/poker/backups/satoshistacks-$(date +\%Y\%m\%d).db
```

---

## 📈 Performance Optimization

### Nginx Caching
Already configured in nginx-config.template:
- Static assets cached for 30 days
- Gzip compression enabled

### PM2 Clustering (If Needed)
```bash
pm2 delete satoshistacks-backend
pm2 start packages/backend/server.js --name satoshistacks-backend -i 2  # 2 instances
```

### Database Optimization
```bash
# Vacuum database periodically
sqlite3 /home/poker/satoshistacks/packages/backend/db/satoshistacks.db "VACUUM;"
```

---

## 💰 Cost Breakdown

- **VPS:** €3.79/month (~$4 USD) - Hetzner CX22
- **Domain:** Already owned
- **SSL:** FREE (Let's Encrypt)
- **Total:** $4/month

---

## 🆘 Support

**Noah available via Telegram for:**
- Deployment assistance
- Bug fixes
- Server issues
- Feature additions

**Common Commands Reference:**
```bash
# Restart backend
pm2 restart satoshistacks-backend

# View logs
pm2 logs satoshistacks-backend

# Restart Nginx
sudo systemctl restart nginx

# Check server status
pm2 status && sudo systemctl status nginx

# View database
sqlite3 /home/poker/satoshistacks/packages/backend/db/satoshistacks.db
```

---

## ✅ Post-Deployment

After successful deployment:

1. **Test thoroughly**
   - Play multiple hands
   - Test with friends
   - Check admin dashboard

2. **Beta test**
   - Invite 5-10 people
   - Collect feedback
   - Note bugs

3. **Monitor**
   - Check PM2 status daily
   - Review logs for errors
   - Monitor server resources

4. **Marketing** (when stable)
   - Discord announcement
   - Reddit posts
   - Social media
   - Friends/family

---

Ready to deploy! 🚀
