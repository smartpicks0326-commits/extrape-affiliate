require('dotenv').config();
const express = require('express');
const morgan = require('morgan');
const path = require('path');

const dashboardRoutes = require('./routes/dashboard');
const scheduler = require('./services/schedulerService');

const app = express();
const PORT = process.env.PORT || 4000;

app.use(morgan('dev'));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(dashboardRoutes);

app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

app.listen(PORT, () => {
  console.log(`[app] SmartPickDeals AI Publisher listening on port ${PORT}`);
  scheduler.start();
});
