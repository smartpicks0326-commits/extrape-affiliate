-- SmartPickDeals AI Publisher - initial schema
-- Run with: psql -d smartpickdeals -f database/migrations/001_init.sql

CREATE TABLE IF NOT EXISTS products (
  id SERIAL PRIMARY KEY,
  source VARCHAR(50) NOT NULL,             -- 'amazon', 'flipkart', 'ajio', etc.
  store VARCHAR(100),
  asin VARCHAR(50),
  title TEXT NOT NULL,
  description TEXT,
  price NUMERIC(12,2),
  discount NUMERIC(5,2),
  rating NUMERIC(2,1),
  image_url TEXT,
  affiliate_url TEXT NOT NULL,
  category VARCHAR(100),
  brand VARCHAR(100),
  status VARCHAR(30) NOT NULL DEFAULT 'imported', -- imported, content_ready, image_ready, queued, published, failed
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source, asin)
);

CREATE INDEX IF NOT EXISTS idx_products_status ON products(status);
CREATE INDEX IF NOT EXISTS idx_products_source ON products(source);

CREATE TABLE IF NOT EXISTS pinterest_queue (
  id SERIAL PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  hashtags TEXT,
  image_path TEXT,
  publish_time TIMESTAMPTZ,
  status VARCHAR(30) NOT NULL DEFAULT 'pending', -- pending, publishing, published, failed
  retry_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  pinterest_pin_id VARCHAR(100),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_queue_status ON pinterest_queue(status);
CREATE INDEX IF NOT EXISTS idx_queue_publish_time ON pinterest_queue(publish_time);

CREATE TABLE IF NOT EXISTS analytics (
  id SERIAL PRIMARY KEY,
  pin_id VARCHAR(100) NOT NULL,
  views INTEGER DEFAULT 0,
  clicks INTEGER DEFAULT 0,
  saves INTEGER DEFAULT 0,
  outbound_clicks INTEGER DEFAULT 0,
  orders INTEGER DEFAULT 0,
  commission NUMERIC(12,2) DEFAULT 0,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_analytics_pin_id ON analytics(pin_id);

-- Simple trigger to keep updated_at fresh on products
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_products_updated_at ON products;
CREATE TRIGGER trg_products_updated_at
BEFORE UPDATE ON products
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
