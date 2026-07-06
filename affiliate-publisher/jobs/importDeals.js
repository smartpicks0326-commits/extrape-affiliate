const { query } = require('../config/database');
const amazonService = require('../services/amazonService');
const extrapeService = require('../services/extrapeService');

async function importDeals() {
  const [amazonDeals, extrapeDeals] = await Promise.all([
    amazonService.fetchDeals({ limit: 10 }).catch((err) => {
      console.error('[importDeals] amazon fetch failed:', err.message);
      return [];
    }),
    extrapeService.fetchDeals({ limit: 10 }).catch((err) => {
      console.error('[importDeals] extrape fetch failed:', err.message);
      return [];
    }),
  ]);

  const allDeals = [...amazonDeals, ...extrapeDeals];
  let inserted = 0;

  for (const deal of allDeals) {
    // ON CONFLICT dedupes on (source, asin) — matches the UNIQUE constraint in the schema.
    const res = await query(
      `INSERT INTO products
        (source, store, asin, title, description, price, discount, rating, image_url, affiliate_url, category, brand, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'imported')
       ON CONFLICT (source, asin) DO NOTHING
       RETURNING id`,
      [
        deal.source,
        deal.store || deal.source,
        deal.asin,
        deal.title,
        deal.description || null,
        deal.price,
        deal.discount || 0,
        deal.rating || null,
        deal.image_url,
        deal.affiliate_url,
        deal.category || null,
        deal.brand || null,
      ]
    );
    if (res.rowCount > 0) inserted += 1;
  }

  console.log(`[importDeals] fetched ${allDeals.length}, inserted ${inserted} new products`);
  return inserted;
}

module.exports = importDeals;
