const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const chromium = require('@sparticuz/chromium');
puppeteer.use(StealthPlugin());
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(express.json());
app.use(cors());

const EXTRAPE_EMAIL    = process.env.EXTRAPE_EMAIL;
const EXTRAPE_PASSWORD = process.env.EXTRAPE_PASSWORD;
const AVG_SECONDS_PER_REQUEST = 12; // average time per conversion

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
  'lenskart.com', 'pepperfry.com',
];

function isSupported(url) {
  try {
    const hostname = new URL(url).hostname.replace('www.', '');
    return SUPPORTED_DOMAINS.some(d => hostname.includes(d));
  } catch { return false; }
}

// ── Queue & Request Store ──
const queue = [];        // pending request IDs in order
const requests = {};     // all request states keyed by ID
let isProcessing = false;

// Request states: pending | processing | done | error
function createRequest(url, store) {
  const id = uuidv4();
  requests[id] = { id, url, store, state: 'pending', position: 0, affiliateLink: null, error: null, createdAt: Date.now() };
  queue.push(id);
  updatePositions();
  return id;
}

function updatePositions() {
  queue.forEach((id, index) => {
    if (requests[id]) requests[id].position = index + 1;
  });
}

function getStatus(id) {
  const r = requests[id];
  if (!r) return null;
  const position = r.state === 'pending' ? r.position : 0;
  const estimatedSeconds = position > 0 ? position * AVG_SECONDS_PER_REQUEST : 0;
  return {
    id: r.id,
    state: r.state,
    position,
    queueLength: queue.length,
    estimatedSeconds,
    affiliateLink: r.affiliateLink,
    error: r.error,
  };
}

// ── Cleanup old requests after 10 mins ──
setInterval(() => {
  const tenMins = 10 * 60 * 1000;
  Object.keys(requests).forEach(id => {
    if (Date.now() - requests[id].createdAt > tenMins) {
      delete requests[id];
    }
  });
}, 60000);

// ── Puppeteer ──
async function screenshot(page, name) {
  try { await page.screenshot({ path: '/tmp/debug_' + name + '.png', fullPage: true }); } catch(e) {}
}

async function waitForAny(page, selectors, timeout) {
  const combined = selectors.join(', ');
  await page.waitForSelector(combined, { timeout: timeout || 10000 });
  return combined;
}

let browser   = null;
let page      = null;
let isLoggedIn = false;

async function getBrowser() {
  if (!browser || !browser.isConnected()) {
    console.log('Launching browser...');
    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: { width: 1280, height: 800 },
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
    });
    isLoggedIn = false;
    console.log('Browser launched');
  }
  return browser;
}

async function loginToExtraPe() {
  const br = await getBrowser();
  page = await br.newPage();
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36'
  );

  const cookiesStr = process.env.EXTRAPE_COOKIES;
  if (!cookiesStr) throw new Error('EXTRAPE_COOKIES not set in environment variables.');

  const cookies = JSON.parse(cookiesStr);
  await page.setCookie(...cookies);
  console.log('Loaded ' + cookies.length + ' cookies');

  await page.goto('https://extrape.com/dashboard', {
    waitUntil: 'domcontentloaded',
    timeout: 30000
  });
  await page.waitForTimeout(4000);
  await screenshot(page, '1_dashboard');

  const url = page.url();
  console.log('URL after cookie login: ' + url);

  if (url.includes('/login')) {
    throw new Error('Cookies expired — please update EXTRAPE_COOKIES in Render.');
  }

  isLoggedIn = true;
  console.log('Logged in via cookies!');
}

async function generateAffiliateLink(productUrl, storeName) {
  if (!isLoggedIn || !page) await loginToExtraPe();

  try {
    console.log('Generating link for [' + storeName + ']: ' + productUrl);

    await page.goto('https://www.extrape.com/link-converter', {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });
    await page.waitForTimeout(6000);
    await screenshot(page, '6_converter');
// Log page content to verify we're on the right page
    const converterPageText = await page.evaluate(() => document.body.innerText);
    console.log('Converter page text:', converterPageText.substring(0, 300));

    // Wait longer for React to render textarea
    await page.waitForSelector('textarea', { timeout: 20000 });

    // Type the product URL into the textarea
    await page.evaluate((url) => {
      const textareas = Array.from(document.querySelectorAll('textarea'));
      const input = textareas.find(t =>
        t.placeholder.includes('http') || t.placeholder.includes('Input')
      );
      if (!input) throw new Error('Input textarea not found');
      const nativeSetter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype, 'value'
      ).set;
      nativeSetter.call(input, url);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }, productUrl);

    console.log('Typed product URL into textarea');
    await page.waitForTimeout(1000);

    // Click Convert button
    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button'))
        .find(b => b.textContent.trim() === 'Convert');
      if (!btn) throw new Error('Convert button not found');
      btn.click();
    });

    console.log('Clicked Convert');
    await page.waitForTimeout(5000);
    await screenshot(page, '7_after_convert');

    // Extract converted link from output textarea
    const affiliateLink = await page.evaluate(() => {
      const textareas = Array.from(document.querySelectorAll('textarea'));
      const output = textareas.find(t =>
        t.placeholder.includes('Converted') || t.value.startsWith('http')
      );
      return output ? output.value.trim() : null;
    });

    console.log('Affiliate link:', affiliateLink);
    if (!affiliateLink) throw new Error('Converted link not found. Check screenshot 7_after_convert.');

    return affiliateLink;

  } catch (err) {
    isLoggedIn = false;
    page = null;
    throw err;
  }
}

// ── Queue Processor ──
async function processQueue() {
  if (isProcessing || queue.length === 0) return;
  isProcessing = true;

  const id = queue.shift();
  updatePositions();
  const req = requests[id];
  if (!req) { isProcessing = false; processQueue(); return; }

  req.state = 'processing';
  console.log('Processing request ' + id + ' for ' + req.store);

  try {
    const link = await generateAffiliateLink(req.url, req.store);
    req.state = 'done';
    req.affiliateLink = link;
  } catch(err) {
    req.state = 'error';
    req.error = err.message;
    console.error('Request ' + id + ' failed:', err.message);
  } finally {
    isProcessing = false;
    processQueue();
  }
}

// ── POST /generate — Add to queue ──
app.post('/generate', async (req, res) => {
  const { url, store } = req.body;
  if (!url) return res.status(400).json({ error: 'No URL provided.' });
  try { new URL(url); } catch { return res.status(400).json({ error: 'Invalid URL.' }); }
  if (!isSupported(url)) return res.status(400).json({ error: 'Store not supported.' });
  if (!EXTRAPE_EMAIL || !EXTRAPE_PASSWORD) return res.status(500).json({ error: 'Credentials missing.' });

  const id = createRequest(url, store || 'Unknown');
  processQueue();

  return res.json({ requestId: id, ...getStatus(id) });
});

// ── GET /status/:id — Poll queue position + result ──
app.get('/status/:id', (req, res) => {
  const status = getStatus(req.params.id);
  if (!status) return res.status(404).json({ error: 'Request not found.' });
  return res.json(status);
});

const fs = require('fs');
app.get('/screenshot/:name', (req, res) => {
  const path = '/tmp/debug_' + req.params.name + '.png';
  if (fs.existsSync(path)) {
    res.setHeader('Content-Type', 'image/png');
    fs.createReadStream(path).pipe(res);
  } else {
    res.status(404).send('Screenshot not found: ' + path);
  }
});

app.get('/', (req, res) => res.send('Smart Pick Deals backend running'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log('Server on port ' + PORT);
  // Pre-warm browser and login on startup
  try {
    await loginToExtraPe();
    console.log('Browser pre-warmed and ready!');
  } catch(err) {
    console.warn('Pre-warm failed:', err.message);
  }
});