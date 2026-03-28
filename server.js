const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const chromium = require('@sparticuz/chromium');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');

puppeteer.use(StealthPlugin());

const app = express();
app.use(express.json());
app.use(cors());

const EXTRAPE_EMAIL    = process.env.EXTRAPE_EMAIL;
const EXTRAPE_PASSWORD = process.env.EXTRAPE_PASSWORD;
const EXTRAPE_COOKIES  = process.env.EXTRAPE_COOKIES;
const AVG_SECONDS_PER_REQUEST = 10;

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

// ── Queue ──
const queue = [];
const requests = {};
let isProcessing = false;

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
  return {
    id: r.id,
    state: r.state,
    position,
    queueLength: queue.length,
    estimatedSeconds: position * AVG_SECONDS_PER_REQUEST,
    affiliateLink: r.affiliateLink,
    error: r.error,
  };
}

setInterval(() => {
  const tenMins = 10 * 60 * 1000;
  Object.keys(requests).forEach(id => {
    if (Date.now() - requests[id].createdAt > tenMins) delete requests[id];
  });
}, 60000);

// ── Browser state — single shared page kept open on converter ──
let browser = null;
let converterPage = null;
let isReady = false;

async function screenshot(name) {
  try {
    if (converterPage) await converterPage.screenshot({ path: '/tmp/debug_' + name + '.png', fullPage: true });
  } catch(e) {}
}

async function setup() {
  console.log('Launching browser...');
  browser = await puppeteer.launch({
    args: chromium.args,
    defaultViewport: { width: 1280, height: 800 },
    executablePath: await chromium.executablePath(),
    headless: chromium.headless,
  });
  console.log('Browser launched');

  converterPage = await browser.newPage();
  await converterPage.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36'
  );

  // Step 1: Go to homepage first
  await converterPage.goto('https://www.extrape.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await converterPage.waitForTimeout(3000);

  // Step 2: Set cookies
  const cookies = JSON.parse(EXTRAPE_COOKIES);
  await converterPage.setCookie(...cookies);
  console.log('Cookies set:', cookies.length);


  // Step 3: Navigate to converter directly
  await converterPage.goto('https://www.extrape.com/link-converter', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await converterPage.waitForTimeout(6000);

  // Step 4: Log what we see
  const url = converterPage.url();
  const title = await converterPage.title();
  console.log('URL:', url);
  console.log('Title:', title);

  const bodyText = await converterPage.evaluate(() => document.body.innerText.substring(0, 200));
  console.log('Page text:', bodyText);

  await screenshot('startup');

  if (!url.includes('link-converter')) {
    // Try once more with a fresh navigation
    console.log('Retrying navigation to converter...');
    await converterPage.goto('https://www.extrape.com/link-converter', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await converterPage.waitForTimeout(8000);

    const url2 = converterPage.url();
    const bodyText2 = await converterPage.evaluate(() => document.body.innerText.substring(0, 200));
    console.log('Retry URL:', url2);
    console.log('Retry page text:', bodyText2);
    await screenshot('startup_retry');
  }

  // Step 5: Wait for textarea
  await converterPage.waitForSelector('textarea', { timeout: 20000 });
  console.log('Converter ready!');

  isReady = true;
}

// ── Convert a single URL using the already-open converter page ──
async function convertUrl(productUrl) {
  if (!isReady || !converterPage) throw new Error('Converter not ready yet. Please try again in a moment.');

  // Clear the input textarea
  await converterPage.evaluate(() => {
    const textareas = Array.from(document.querySelectorAll('textarea'));
    const input = textareas.find(t => t.placeholder.includes('http') || t.placeholder.includes('Input') || t.placeholder.includes('Links'));
    if (input) {
      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      nativeSetter.call(input, '');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });

  // Paste the product URL
  await converterPage.evaluate((url) => {
    const textareas = Array.from(document.querySelectorAll('textarea'));
    const input = textareas.find(t => t.placeholder.includes('http') || t.placeholder.includes('Input') || t.placeholder.includes('Links'));
    if (!input) throw new Error('Input textarea not found');
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    nativeSetter.call(input, url);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, productUrl);

  console.log('Pasted URL: ' + productUrl);
  await converterPage.waitForTimeout(500);

  // Click Convert
  await converterPage.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button'))
      .find(b => b.textContent.trim() === 'Convert');
    if (!btn) throw new Error('Convert button not found');
    btn.click();
  });

  console.log('Clicked Convert');
  await converterPage.waitForTimeout(5000);

  // Read the output textarea
  const affiliateLink = await converterPage.evaluate(() => {
    const textareas = Array.from(document.querySelectorAll('textarea'));
    const output = textareas.find(t =>
      t.placeholder.includes('Converted') || (t.value && t.value.startsWith('http'))
    );
    return output ? output.value.trim() : null;
  });

  if (!affiliateLink) {
    await screenshot('error_no_output');
    const allTextareas = await converterPage.evaluate(() =>
      Array.from(document.querySelectorAll('textarea')).map(t => ({
        placeholder: t.placeholder, value: t.value.substring(0, 100)
      }))
    );
    console.log('All textareas:', JSON.stringify(allTextareas));
    throw new Error('Converted link not found in output. Check logs.');
  }

  console.log('Converted link: ' + affiliateLink);
  return affiliateLink;
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
  console.log('Processing: ' + id + ' [' + req.store + ']');

  try {
    const link = await convertUrl(req.url);
    req.state = 'done';
    req.affiliateLink = link;
  } catch(err) {
    req.state = 'error';
    req.error = err.message;
    console.error('Failed:', err.message);
  } finally {
    isProcessing = false;
    processQueue();
  }
}

// ── API Routes ──
app.post('/generate', async (req, res) => {
  const { url, store } = req.body;
  if (!url) return res.status(400).json({ error: 'No URL provided.' });
  try { new URL(url); } catch { return res.status(400).json({ error: 'Invalid URL.' }); }
  if (!isSupported(url)) return res.status(400).json({ error: 'Store not supported.' });
  if (!isReady) return res.status(503).json({ error: 'Converter is warming up. Please try again in a moment.' });

  const id = createRequest(url, store || 'Unknown');
  processQueue();
  return res.json({ requestId: id, ...getStatus(id) });
});

app.get('/status/:id', (req, res) => {
  const status = getStatus(req.params.id);
  if (!status) return res.status(404).json({ error: 'Request not found.' });
  return res.json(status);
});

app.get('/screenshot/:name', (req, res) => {
  const path = '/tmp/debug_' + req.params.name + '.png';
  if (fs.existsSync(path)) {
    res.setHeader('Content-Type', 'image/png');
    fs.createReadStream(path).pipe(res);
  } else {
    res.status(404).send('Screenshot not found: ' + path);
  }
});

app.get('/', (req, res) => res.send('Smart Pick Deals backend running. Ready: ' + isReady));

// ── Start ──
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log('Server on port ' + PORT);
  try {
    await setup();
  } catch(err) {
    console.error('Setup failed:', err.message);
    isReady = false;
  }
});