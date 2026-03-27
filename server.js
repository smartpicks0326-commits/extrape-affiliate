const express = require('express');
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');
const cors = require('cors');
const fs = require('fs');

const app = express();
app.use(express.json());
app.use(cors());

const EXTRAPE_EMAIL    = process.env.EXTRAPE_EMAIL;
const EXTRAPE_PASSWORD = process.env.EXTRAPE_PASSWORD;

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
  } catch {
    return false;
  }
}

async function screenshot(page, name) {
  try {
    await page.screenshot({ path: '/tmp/debug_' + name + '.png', fullPage: true });
    console.log('Screenshot: ' + name);
  } catch(e) {}
}

async function waitForAny(page, selectors, timeout) {
  const combined = selectors.join(', ');
  await page.waitForSelector(combined, { timeout: timeout || 10000 });
  return combined;
}

// ── Click button by EXACT text match ──
async function clickButtonExact(page, exactText) {
  const found = await page.evaluate((text) => {
    const buttons = Array.from(document.querySelectorAll('button'));
    const btn = buttons.find(b => b.textContent.trim() === text);
    if (btn) { btn.click(); return true; }
    return false;
  }, exactText);
  if (!found) throw new Error('Button "' + exactText + '" not found');
  console.log('Clicked: ' + exactText);
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

  console.log('Navigating to ExtraPe login...');
  await page.goto('https://extrape.com/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(8000);
  await screenshot(page, '1_login_page');

  const inputs = await page.evaluate(() =>
    Array.from(document.querySelectorAll('input')).map(i => ({
      type: i.type, name: i.name, id: i.id, placeholder: i.placeholder
    }))
  );
  console.log('Inputs on login page:', JSON.stringify(inputs));

  // ── Step 1: Type email ──
  await page.waitForSelector('input[name="emailorphone"]', { timeout: 10000 });
  await page.click('input[name="emailorphone"]');
  await page.type('input[name="emailorphone"]', EXTRAPE_EMAIL, { delay: 80 });
  console.log('Typed email');
  await screenshot(page, '2_email_typed');

  // ── Log all buttons before clicking ──
  const btns = await page.evaluate(() =>
    Array.from(document.querySelectorAll('button')).map(b => b.textContent.trim())
  );
  console.log('Buttons before Continue:', JSON.stringify(btns));

  // ── Step 2: Click Continue using real mouse click ──
const continueBtn = await page.evaluateHandle(() => {
  const buttons = Array.from(document.querySelectorAll('button'));
  return buttons.find(b => b.textContent.trim() === 'Continue');
});
await continueBtn.asElement().click();
console.log('Clicked Continue via real mouse click');
await page.waitForTimeout(5000);
await screenshot(page, '3_after_continue');

  const inputs2 = await page.evaluate(() =>
    Array.from(document.querySelectorAll('input')).map(i => ({
      type: i.type, name: i.name, id: i.id, placeholder: i.placeholder
    }))
  );
  console.log('Inputs after Continue:', JSON.stringify(inputs2));

  // ── Step 3: Type password ──
  await page.waitForSelector('input[name="password"]', { timeout: 15000 });
  await page.click('input[name="password"]');
  await page.type('input[name="password"]', EXTRAPE_PASSWORD, { delay: 80 });
  console.log('Typed password');
  await screenshot(page, '4_password_typed');

  // ── Step 4: Click EXACT "Submit" ──
  await clickButtonExact(page, 'Submit');
  await page.waitForTimeout(5000);
  await screenshot(page, '5_after_submit');

  const urlAfter = page.url();
  console.log('URL after submit: ' + urlAfter);

  await page.waitForFunction(
    () => !document.querySelector('input[name="password"]'),
    { timeout: 20000 }
  );

  isLoggedIn = true;
  console.log('Logged in successfully!');
}

async function generateAffiliateLink(productUrl, storeName) {
  if (!isLoggedIn || !page) {
    await loginToExtraPe();
  }

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
      'input[placeholder*="product"]',
      'input[placeholder*="Product"]',
      'input[placeholder*="url"]',
      'input[placeholder*="URL"]',
      'input[placeholder*="link"]',
      'input[placeholder*="Link"]',
      'input[placeholder*="paste"]',
      'input[placeholder*="Paste"]',
      'input[placeholder*="http"]',
      'input[name="url"]',
      'input[name="link"]',
      'input[name="productUrl"]',
      'textarea',
    ], 15000);

    await page.click(inputSel, { clickCount: 3 });
    await page.type(inputSel, productUrl, { delay: 40 });
    console.log('Typed URL into: ' + inputSel);
    await screenshot(page, '7_url_typed');

    const buttons = await page.evaluate(() =>
      Array.from(document.querySelectorAll('button')).map(b => b.textContent.trim())
    );
    console.log('Dashboard buttons:', JSON.stringify(buttons));

    const generateTexts = ['Generate', 'Convert', 'Get Link', 'Create', 'Submit', 'Go', 'Shorten', 'Get'];
    let clicked = false;
    for (const text of generateTexts) {
      try {
        await clickButtonExact(page, text);
        clicked = true;
        break;
      } catch(e) { continue; }
    }

    if (!clicked) {
      // Click first available button as fallback
      await page.evaluate(() => {
        const btns = document.querySelectorAll('button');
        if (btns.length > 0) btns[0].click();
      });
      console.log('Clicked first available button as fallback');
    }

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
        if (link.href && (link.href.includes('extrape') || link.href.includes('fkrt') || link.href.includes('amzn'))) {
          return link.href;
        }
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

app.post('/generate', async (req, res) => {
  const { url, store } = req.body;
  if (!url) return res.status(400).json({ error: 'No URL provided.' });
  try { new URL(url); } catch { return res.status(400).json({ error: 'Invalid URL.' }); }
  if (!isSupported(url)) return res.status(400).json({ error: 'Store not supported.' });
  if (!EXTRAPE_EMAIL || !EXTRAPE_PASSWORD) return res.status(500).json({ error: 'Credentials missing.' });
  try {
    const affiliateLink = await generateAffiliateLink(url, store || 'Unknown');
    return res.json({ affiliateLink, store: store || 'Unknown' });
  } catch (err) {
    console.error('Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

app.get('/debug', (req, res) => {
  try {
    const files = fs.readdirSync('/tmp').filter(f => f.startsWith('debug_'));
    res.json({ screenshots: files });
  } catch(e) { res.json({ error: e.message }); }
});

app.get('/', (req, res) => res.send('Smart Pick Deals backend running'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server on port ' + PORT));