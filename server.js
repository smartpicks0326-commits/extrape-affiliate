const express = require('express');
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

const EXTRAPE_EMAIL    = process.env.EXTRAPE_EMAIL;
const EXTRAPE_PASSWORD = process.env.EXTRAPE_PASSWORD;

// ── All supported ExtraPe store domains ──
const SUPPORTED_DOMAINS = [
  'amazon.in', 'amazon.com', 'amzn.in', 'amzn.to',
  'flipkart.com', 'dl.flipkart.com',
  'myntra.com', 'ajio.com',
  'nykaa.com', 'nykaafashion.com', 'nykaabeauty.com',
  'tatacliq.com', 'tatacliq.luxury',
  'croma.com', 'snapdeal.com', 'boat-lifestyle.com',
  'makemytrip.com', 'cleartrip.com',
  'netflix.com', 'sonyliv.com', 'hotstar.com',
  'netmeds.com', '1mg.com', 'pharmeasy.in',
  'mamaearth.in', 'wowskinscience.com',
  'meesho.com', 'jiomart.com',
  'bigbasket.com', 'firstcry.com',
  'lenskart.com', 'pepperfry.com', 'urban ladder.com',
];

function isSupported(url) {
  try {
    const hostname = new URL(url).hostname.replace('www.', '');
    return SUPPORTED_DOMAINS.some(d => hostname.includes(d));
  } catch { return false; }
}

// ── Reuse browser session ──
let browser = null;
let page    = null;
let isLoggedIn = false;

async function getBrowser() {
  if (!browser || !browser.isConnected()) {
    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
    });
    isLoggedIn = false;
  }
  return browser;
}

async function loginToExtraPe() {
  const br = await getBrowser();
  page = await br.newPage();
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36'
  );

  console.log('🔑 Logging into ExtraPe...');
  await page.goto('https://extrape.com/login', { waitUntil: 'networkidle2', timeout: 30000 });

  await page.waitForSelector('input[type="email"], input[name="email"]', { timeout: 10000 });
  await page.type('input[type="email"], input[name="email"]', EXTRAPE_EMAIL, { delay: 50 });
  await page.type('input[type="password"], input[name="password"]', EXTRAPE_PASSWORD, { delay: 50 });

  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }),
    page.click('button[type="submit"], input[type="submit"]'),
  ]);

  if (page.url().includes('login')) {
    throw new Error('Login failed — check your ExtraPe credentials.');
  }

  isLoggedIn = true;
  console.log('✅ Logged into ExtraPe');
}

async function generateAffiliateLink(productUrl, storeName) {
  if (!isLoggedIn || !page) await loginToExtraPe();

  try {
    console.log(`🔗 Generating affiliate link for [${storeName}]: ${productUrl}`);

    // Navigate to ExtraPe link generator / dashboard
    await page.goto('https://extrape.com/dashboard', { waitUntil: 'networkidle2', timeout: 20000 });

    // ── Paste the product URL into the input field ──
    // NOTE: Update this selector to match ExtraPe's actual input field
    await page.waitForSelector(
      'input[placeholder*="product"], input[placeholder*="url"], input[placeholder*="link"], textarea[name*="url"]',
      { timeout: 10000 }
    );

    const inputSel = 'input[placeholder*="product"], input[placeholder*="url"], input[placeholder*="link"], textarea[name*="url"]';
    await page.click(inputSel, { clickCount: 3 });
    await page.type(inputSel, productUrl, { delay: 30 });

    // ── Click Generate / Convert ──
    // NOTE: Update selector to match ExtraPe's button
    await page.click('button[type="submit"], button:has-text("Generate"), button:has-text("Convert"), button:has-text("Create Link")');

    // ── Wait for output and extract affiliate link ──
    await page.waitForSelector(
      '.affiliate-link, .short-link, input.result-link, [data-affiliate-link], .earning-link',
      { timeout: 15000 }
    );

    const affiliateLink = await page.$eval(
      '.affiliate-link, .short-link, input.result-link, [data-affiliate-link], .earning-link',
      el => el.value || el.textContent || el.href
    );

    if (!affiliateLink) throw new Error('Could not extract affiliate link from ExtraPe.');

    console.log(`✅ Done [${storeName}]: ${affiliateLink}`);
    return affiliateLink.trim();

  } catch (err) {
    isLoggedIn = false;
    page = null;
    throw err;
  }
}

// ── POST /generate ──
app.post('/generate', async (req, res) => {
  const { url, store } = req.body;

  if (!url) return res.status(400).json({ error: 'No URL provided.' });

  // Validate URL
  try { new URL(url); } catch {
    return res.status(400).json({ error: 'Invalid URL format.' });
  }

  // Check against supported domains
  if (!isSupported(url)) {
    return res.status(400).json({
      error: `This store doesn't appear to be supported by ExtraPe. Please use a URL from Amazon, Flipkart, Myntra, Ajio, Nykaa, TataCliq, and other supported stores.`
    });
  }

  if (!EXTRAPE_EMAIL || !EXTRAPE_PASSWORD) {
    return res.status(500).json({ error: 'ExtraPe credentials not configured on the server.' });
  }

  try {
    const affiliateLink = await generateAffiliateLink(url, store || 'Unknown');
    return res.json({ affiliateLink, store: store || 'Unknown' });
  } catch (err) {
    console.error('❌ Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── Health check ──
app.get('/', (req, res) => res.send('AffiLink backend running ✅'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server on port ${PORT}`);
  if (EXTRAPE_EMAIL && EXTRAPE_PASSWORD) {
    loginToExtraPe().catch(err => console.warn('⚠ Pre-login failed:', err.message));
  }
});

