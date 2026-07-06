const { query } = require('../config/database');
const pinterestService = require('../services/pinterestService');

const MAX_RETRIES = 3;

async function publishPinterest() {
  const { rows: queueItems } = await query(
    `SELECT q.*, p.affiliate_url
     FROM pinterest_queue q
     JOIN products p ON p.id = q.product_id
     WHERE q.status = 'pending' AND q.image_path IS NOT NULL
     LIMIT 20`
  );

  let published = 0;

  for (const item of queueItems) {
    try {
      const result = await pinterestService.publishPin({
        title: item.title,
        description: `${item.description}\n\n${item.hashtags}`,
        imagePath: item.image_path,
        link: item.affiliate_url,
      });

      await query(
        `UPDATE pinterest_queue SET status = 'published', pinterest_pin_id = $1, publish_time = now() WHERE id = $2`,
        [result.id, item.id]
      );
      await query(`UPDATE products SET status = 'published' WHERE id = $1`, [item.product_id]);
      published += 1;
    } catch (err) {
      console.error(`[publishPinterest] failed for queue item ${item.id}:`, err.message);

      const newRetryCount = item.retry_count + 1;
      const newStatus = newRetryCount >= MAX_RETRIES ? 'failed' : 'pending';

      await query(
        `UPDATE pinterest_queue SET retry_count = $1, status = $2, last_error = $3 WHERE id = $4`,
        [newRetryCount, newStatus, err.message, item.id]
      );
    }
  }

  console.log(`[publishPinterest] published ${published}/${queueItems.length}`);
  return published;
}

module.exports = publishPinterest;
