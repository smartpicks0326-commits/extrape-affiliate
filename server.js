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
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36');

  console.log('Navigating to ExtraPe login...');
  await page.goto('https://extrape.com/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(8000);

  // Step 1: Type email using keyboard simulation
  await page.waitForSelector('input[name="emailorphone"]', { timeout: 10000 });
  await page.evaluate(() => {
    document.querySelector('input[name="emailorphone"]').focus();
  });
  await page.waitForTimeout(500);
  await page.keyboard.type(EXTRAPE_EMAIL, { delay: 100 });
  console.log('Typed email:', EXTRAPE_EMAIL);
  await page.waitForTimeout(1000);

  // Verify email was typed
  const emailVal = await page.$eval('input[name="emailorphone"]', el => el.value);
  console.log('Email field value:', emailVal);

  // Step 2: Submit form directly via React form submit
  await page.evaluate(() => {
    const input = document.querySelector('input[name="emailorphone"]');

    // Trigger all React events on the input
    ['focus', 'keydown', 'keypress', 'keyup', 'input', 'change', 'blur'].forEach(eventType => {
      input.dispatchEvent(new Event(eventType, { bubbles: true }));
    });

    // Find and submit the form directly
    const form = input.closest('form');
    if (form) {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      console.log('Submitted form directly');
    }

    // Also try clicking the button as backup
    const btn = Array.from(document.querySelectorAll('button'))
      .find(b => b.textContent.trim() === 'Continue');
    if (btn) {
      btn.removeAttribute('disabled');
      btn.click();
    }
  });
  console.log('Attempted form submit + button click');
  await page.waitForTimeout(6000);
  await screenshot(page, '3_after_continue');

  const pageText2 = await page.evaluate(() => document.body.innerText);
  console.log('Page text after submit:', pageText2.substring(0, 200));

  // Step 3: Type password character by character
  await page.waitForSelector('input[name="password"]', { timeout: 15000 });
  await page.click('input[name="password"]');
  await page.type('input[name="password"]', EXTRAPE_PASSWORD, { delay: 100 });
  console.log('Typed password');
  await page.waitForTimeout(1000);

  // Step 4: Click Submit via real element handle
  const submitBtn = await page.evaluateHandle(() => {
    return Array.from(document.querySelectorAll('button'))
      .find(b => b.textContent.trim() === 'Submit');
  });
  await submitBtn.asElement().click();
  console.log('Clicked Submit');
  await page.waitForTimeout(6000);

  await page.waitForFunction(
    () => !document.querySelector('input[name="password"]'),
    { timeout: 20000 }
  );

  isLoggedIn = true;
  console.log('Logged in successfully!');
}

async function generateAffiliateLink(productUrl, storeName) {
  if (!isLoggedIn || !page) await loginToExtraPe();

  try {
    console.log('Generating link for [' + storeName + ']: ' + productUrl);
    await page.goto('https://extrape.com/dashboard', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(4000);
    await screenshot(page, '6_dashboard');

    const inputs = await page.evaluate(() =>
      Array.from(document.querySelectorAll('input, textarea')).map(i => ({
        type: i.type, name: i.name, id: i.id, placeholder: i.placeholder
      }))
    );
    console.log('Dashboard inputs:', JSON.stringify(inputs));

    const inputSel = await waitForAny(page, [
      'input[placeholder*="product"]', 'input[placeholder*="Product"]',
      'input[placeholder*="url"]', 'input[placeholder*="URL"]',
      'input[placeholder*="link"]', 'input[placeholder*="Link"]',
      'input[placeholder*="paste"]', 'input[placeholder*="Paste"]',
      'input[placeholder*="http"]',
      'input[name="url"]', 'input[name="link"]', 'input[name="productUrl"]',
      'textarea',
    ], 15000);

    await page.evaluate((sel, url) => {
      const input = document.querySelector(sel);
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      nativeInputValueSetter.call(input, url);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }, inputSel.split(',')[0].trim(), productUrl);

    console.log('Typed product URL');
    await page.waitForTimeout(1000);
    await page.focus(inputSel.split(',')[0].trim());
    await page.keyboard.press('Enter');
    await page.waitForTimeout(4000);
    await screenshot(page, '8_after_generate');

    const results = await page.evaluate(() =>
      Array.from(document.querySelectorAll('input')).map(i => ({
        name: i.name, value: i.value, placeholder: i.placeholder
      }))
    );
    console.log('Inputs after generate:', JSON.stringify(results));

    const affiliateLink = await page.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll('input'));
      for (const input of inputs) {
        if (input.value && input.value.startsWith('http')) return input.value;
      }
      const links = Array.from(document.querySelectorAll('a'));
      for (const link of links) {
        if (link.href && (link.href.includes('extrape') || link.href.includes('fkrt') || link.href.includes('amzn'))) return link.href;
      }
      const els = document.querySelectorAll('[class*="link"], [class*="result"], [class*="affiliate"], [class*="short"], [class*="copy"]');
      for (const el of els) {
        const text = el.value || el.textContent.trim();
        if (text && text.startsWith('http')) return text;
      }
      return null;
    });

    if (!affiliateLink) throw new Error('Could not find affiliate link. Check logs and screenshots.');
    console.log('Success! Link: ' + affiliateLink);
    return affiliateLink.trim();

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
app.listen(PORT, () => console.log('Server on port ' + PORT));