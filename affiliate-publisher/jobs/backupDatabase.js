const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const util = require('util');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

const execAsync = util.promisify(exec);

const BACKUP_DIR = path.join(__dirname, '..', 'generated', 'logs', 'backups');
if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

function getR2Client() {
  return new S3Client({
    region: 'auto',
    endpoint: process.env.R2_ENDPOINT,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
  });
}

async function backupDatabase() {
  if (!process.env.R2_ACCESS_KEY_ID || !process.env.PGDATABASE) {
    console.warn('[backupDatabase] R2 or Postgres env vars not fully set — skipping backup');
    return;
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `smartpickdeals-${timestamp}.sql.gz`;
  const filepath = path.join(BACKUP_DIR, filename);

  // Requires pg_dump + gzip on PATH (standard on any box with postgresql-client installed).
  const dumpCmd = `pg_dump -h ${process.env.PGHOST} -p ${process.env.PGPORT} -U ${process.env.PGUSER} -d ${process.env.PGDATABASE} | gzip > ${filepath}`;

  await execAsync(dumpCmd, {
    env: { ...process.env, PGPASSWORD: process.env.PGPASSWORD },
  });

  const fileBuffer = fs.readFileSync(filepath);

  const client = getR2Client();
  await client.send(
    new PutObjectCommand({
      Bucket: process.env.R2_BUCKET,
      Key: `db-backups/${filename}`,
      Body: fileBuffer,
    })
  );

  console.log(`[backupDatabase] uploaded ${filename} to R2 bucket ${process.env.R2_BUCKET}`);

  // Keep only the local copy from the last 3 days to avoid filling local disk.
  const cutoff = Date.now() - 3 * 24 * 60 * 60 * 1000;
  for (const f of fs.readdirSync(BACKUP_DIR)) {
    const fp = path.join(BACKUP_DIR, f);
    if (fs.statSync(fp).mtimeMs < cutoff) fs.unlinkSync(fp);
  }
}

module.exports = backupDatabase;
