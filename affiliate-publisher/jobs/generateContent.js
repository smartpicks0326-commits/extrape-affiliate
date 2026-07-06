const { query } = require('../config/database');
const aiService = require('../services/aiService');

async function generateContent() {
  const { rows: products } = await query(
    `SELECT * FROM products WHERE status = 'imported' LIMIT 20`
  );

  let processed = 0;

  for (const product of products) {
    try {
      const content = await aiService.generateContent(product);

      await query(
        `INSERT INTO pinterest_queue (product_id, title, description, hashtags, status)
         VALUES ($1, $2, $3, $4, 'pending')`,
        [product.id, content.title, content.description, content.hashtags]
      );

      await query(`UPDATE products SET status = 'content_ready' WHERE id = $1`, [product.id]);
      processed += 1;
    } catch (err) {
      console.error(`[generateContent] failed for product ${product.id}:`, err.message);
      await query(`UPDATE products SET status = 'failed' WHERE id = $1`, [product.id]);
    }
  }

  console.log(`[generateContent] processed ${processed}/${products.length} products`);
  return processed;
}

module.exports = generateContent;
