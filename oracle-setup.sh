#!/bin/bash
# Run this on your Oracle Cloud Ubuntu server
# One command sets up everything

echo "🚀 Setting up Smart Pick Deals on Oracle Cloud..."

# 1. Update system
sudo apt-get update -y && sudo apt-get upgrade -y

# 2. Install Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# 3. Install nginx + certbot (free SSL)
sudo apt-get install -y nginx certbot python3-certbot-nginx

# 4. Install PM2 (keeps Node.js running forever)
sudo npm install -g pm2

# 5. Clone your project
git clone https://github.com/smartpicks0326-commits/extrape-affiliate.git ~/extrape-affiliate
cd ~/extrape-affiliate && npm install --production

# 6. Setup nginx
sudo cp nginx.conf /etc/nginx/sites-available/smartpickdeals
sudo ln -sf /etc/nginx/sites-available/smartpickdeals /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx

# 7. Get free SSL certificate
sudo certbot --nginx -d smartpickdeals.live -d www.smartpickdeals.live --non-interactive --agree-tos -m smartpicks0326@gmail.com

# 8. Open firewall
sudo iptables -A INPUT -p tcp --dport 80 -j ACCEPT
sudo iptables -A INPUT -p tcp --dport 443 -j ACCEPT
sudo iptables -A INPUT -p tcp --dport 3000 -j ACCEPT
sudo apt-get install -y iptables-persistent
sudo netfilter-persistent save

echo ""
echo "✅ Setup complete!"
echo ""
echo "Next steps:"
echo "1. Create .env file: nano ~/extrape-affiliate/.env"
echo "2. Start server: cd ~/extrape-affiliate && pm2 start server.js --name smartpickdeals && pm2 save && pm2 startup"
echo "3. Point smartpickdeals.live DNS to this server IP in Cloudflare"
echo "4. Test: curl https://smartpickdeals.live/ping"
