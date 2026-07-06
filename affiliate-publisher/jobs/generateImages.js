const { query } = require('../config/database');
const imageService = require('../services/imageService');

async function generateImages() {
  const { rows: queueItems } = await query(
    `SELECT q.id AS queue_id, p.*
     FROM pinterest_queue q
     JOIN products p ON p.id = q.product_id
     WHERE q.status = 'pending' AND q.image_path IS NULL
     LIMIT 20`
  );

  let processed = 0;

  for (const item of queueItems) {
    try {
      const imagePath = await imageService.generatePinImage(item, `product-${item.id}`);

      await query(`UPDATE pinterest_queue SET image_path = $1 WHERE id = $2`, [
        imagePath,
        item.queue_id,
      ]);
      await query(`UPDATE products SET status = 'image_ready' WHERE id = $1`, [item.id]);
      processed += 1;
    } catch (err) {
      console.error(`[generateImages] failed for queue item ${item.queue_id}:`, err.message);
      await query(
        `UPDATE pinterest_queue SET retry_count = retry_count + 1, status = CASE WHEN retry_count >= 2 THEN 'failed' ELSE status END WHERE id = $1`,
        [item.queue_id]
      );
    }
  }

  console.log(`[generateImages] processed ${processed}/${queueItems.length} images`);
  return processed;
}

module.exports = generateImages;
