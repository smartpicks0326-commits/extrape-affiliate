const express = require('express');
const router = express.Router();
const { query } = require('../config/database');

router.get('/api/stats', async (req, res) => {
  try {
    const [imports, pending, published, scheduled, revenue] = await Promise.all([
      query(`SELECT source, COUNT(*) FROM products WHERE created_at::date = CURRENT_DATE GROUP BY source`),
      query(`SELECT COUNT(*) FROM products WHERE status IN ('imported','content_ready','image_ready')`),
      query(`SELECT COUNT(*) FROM pinterest_queue WHERE status = 'published' AND publish_time::date = CURRENT_DATE`),
      query(`SELECT COUNT(*) FROM pinterest_queue WHERE status = 'pending' AND publish_time IS NOT NULL`),
      query(`SELECT COALESCE(SUM(commission),0) AS total FROM analytics WHERE recorded_at::date = CURRENT_DATE`),
    ]);

    res.json({
      todayImports: imports.rows,
      pending: pending.rows[0].count,
      published: published.rows[0].count,
      scheduled: scheduled.rows[0].count,
      revenue: revenue.rows[0].total,
    });
  } catch (err) {
    console.error('[dashboard] stats query failed:', err);
    res.status(500).json({ error: 'Failed to load stats' });
  }
});

module.exports = router;
