const fs = require('fs');
const path = require('path');
const { pool } = require('../config/database');

async function migrate() {
  const dir = path.join(__dirname, 'migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

  for (const file of files) {
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    console.log(`[migrate] applying ${file}...`);
    await pool.query(sql);
    console.log(`[migrate] done ${file}`);
  }

  console.log('[migrate] all migrations applied');
  await pool.end();
}

migrate().catch((err) => {
  console.error('[migrate] failed:', err);
  process.exit(1);
});
