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

// ── Save screenshot for debugging ──
async function screenshot(page, name) {
  try {
    const path = '/tmp/debug_' + name + '.png';
    await page.screenshot({ path, fullPage: true });
    console.log('Screenshot saved: ' + path);
  } catch(e) {
    console.log('Screenshot failed: ' + e.message);
  }
}

// ── Wait for any selector from a list ──
async function waitForAny(page, selectors, timeout = 10000) {
  const combined = selectors.join(', ');
  try {
    await page.waitForSelector(combined, { timeout });
    return combined;
  } catch(e) {
    throw new Error('None of these selectors found: ' + selectors.join(' | '));
  }
}

// ── Click button by partial text ──
async function clickButtonByText(page, text) {
  const found = await page.evaluate((text) => {
    const buttons = Array.from(document.querySelectorAll('button, [role="button"], a.btn, input[type="submit"]'));
    const btn = buttons.find(b => b.textContent.trim().toLowerCase().includes(text.toLowerCase()));
    if (btn) { btn.click(); return true; }
    return false;
  }, text);
  if (!found) throw new Error('Button with text "' + text + '" not found');
  console.log('Clicked button: ' + text);
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
  await page.goto('https://extrape.com/login', {
    waitUntil: 'domcontentloaded',
    timeout: 30000
  });

  // Extra wait for React to render
  await page.waitForTimeout(8000);
  await screenshot(page, '1_login_page');

  // Log all inputs found on page for debugging
  const inputs = await page.evaluate(() =>
    Array.from(document.querySelectorAll('input')).map(i => ({
      type: i.type, name: i.name, id: i.id, placeholder: i.placeholder
    }))
  );
  console.log('Inputs found on login page:', JSON.stringify(inputs));

  // ── Step 1: Find and fill email/phone field ──
  const emailSel = await waitForAny(page, [
    'input[name="emailorphone"]',
    'input[type="email"]',
    'input[type="tel"]',
    'input[type="text"]',
    'input[placeholder*="mail"]',
    'input[placeholder*="phone"]',
    'input[placeholder*="Phone"]',
    'input[placeholder*="Email"]',
    'input[placeholder*="Mobile"]',
  ], 15000);

  await page.click(emailSel);
  await page.type(emailSel, EXTRAPE_EMAIL, { delay: 80 });
  console.log('Typed email into: ' + emailSel);
  await screenshot(page, '2_email_typed');

  // ── Step 2: Log all buttons then click Continue ──
const allButtons = await page.evaluate(() =>
  Array.from(document.querySelectorAll('button')).map(b => ({
    text: b.textContent.trim(),
    inner: b.innerHTML.substring(0, 100)
  }))
);
console.log('Buttons on login page:', JSON.stringify(allButtons));

// Click using JS directly on first button found
await page.evaluate(() => {
  const buttons = Array.from(document.querySelectorAll('button'));
  if (buttons.length > 0) buttons[0].click();
});

console.log('Clicked first button on page');
// Wait longer for password screen to animate in
await page.waitForTimeout(5000);
await screenshot(page, '3_after_continue');

const inputs2 = await page.evaluate(() =>
  Array.from(document.querySelectorAll('input')).map(i => ({
    type: i.type, name: i.name, id: i.id, placeholder: i.placeholder
  }))
);
console.log('Inputs after Continue:', JSON.stringify(inputs2));

const buttons2 = await page.evaluate(() =>
  Array.from(document.querySelectorAll('button')).map(b => b.textContent.trim())
);
console.log('Buttons after Continue:', JSON.stringify(buttons2));

  // ── Step 3: Find and fill password field ──
  const passSel = await waitForAny(page, [
    'input[name="password"]',
    'input[type="password"]',
    'input[placeholder*="assword"]',
    'input[placeholder*="Password"]',
  ], 15000);

  await page.click(passSel);
  await page.type(passSel, EXTRAPE_PASSWORD, { delay: 80 });
  console.log('Typed password into: ' + passSel);
  await screenshot(page, '4_password_typed');

  // ── Step 4: Click Submit ──
  await clickButtonByText(page, 'Submit');
  await page.waitForTimeout(4000);
  await screenshot(page, '5_after_submit');

  // Check current URL and page content
  const currentUrl = page.url();
  console.log('URL after submit: ' + currentUrl);

  const pageText = await page.evaluate(() => document.body.innerText.substring(0, 200));
  console.log('Page content after submit: ' + pageText);

  if (currentUrl.includes('/login')) {
    throw new Error('Still on login page after submit. Check credentials or screenshot 5_after_submit.');
  }

  isLoggedIn = true;
  console.log('Logged into ExtraPe successfully. Current URL: ' + currentUrl);
}

async function generateAffiliateLink(productUrl, storeName) {
  if (!isLoggedIn || !page) {
    await loginToExtraPe();
  }

  try {
    console.log('Generating link for [' + storeName + ']: ' + productUrl);

    await page.goto('https://extrape.com/dashboard', {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });
    await page.waitForTimeout(3000);
    await screenshot(page, '6_dashboard');

    // Log all inputs on dashboard
    const inputs = await page.evaluate(() =>
      Array.from(document.querySelectorAll('input, textarea')).map(i => ({
        type: i.type, name: i.name, id: i.id, placeholder: i.placeholder
      }))
    );
    console.log('Dashboard inputs:', JSON.stringify(inputs));

    // ── Find the URL input field ──
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
      'textarea[placeholder*="url"]',
      'textarea[placeholder*="link"]',
    ], 15000);

    await page.click(inputSel, { clickCount: 3 });
    await page.type(inputSel, productUrl, { delay: 40 });
    console.log('Typed product URL into: ' + inputSel);
    await screenshot(page, '7_url_typed');

    // Log all buttons on dashboard
    const buttons = await page.evaluate(() =>
      Array.from(document.querySelectorAll('button')).map(b => b.textContent.trim())
    );
    console.log('Dashboard buttons:', JSON.stringify(buttons));

    // Click the generate button
    const generateTexts = ['Generate', 'Convert', 'Get Link', 'Create', 'Submit', 'Go', 'Shorten'];
    let clicked = false;
    for (const text of generateTexts) {
      try {
        await clickButtonByText(page, text);
        clicked = true;
        break;
      } catch(e) {
        continue;
      }
    }
    if (!clicked) throw new Error('Could not find generate button. Buttons found: ' + JSON.stringify(buttons));

    await page.waitForTimeout(4000);
    await screenshot(page, '8_after_generate');

    // Log all links and inputs after generating
    const results = await page.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll('input')).map(i => ({
        tag: 'input', value: i.value, name: i.name, placeholder: i.placeholder
      }));
      const links = Array.from(document.querySelectorAll('a[href*="extrape"], a[href*="fkrt"], a[href*="amzn"]')).map(a => ({
        tag: 'a', href: a.href, text: a.textContent.trim().substring(0, 50)
      }));
      const spans = Array.from(document.querySelectorAll('[class*="link"], [class*="result"], [class*="affiliate"], [class*="short"]')).map(el => ({
        tag: el.tagName, text: el.textContent.trim().substring(0, 100)
      }));
      return { inputs, links, spans };
    });
    console.log('Results after generate:', JSON.stringify(results));

    // Try to extract the affiliate link
    const affiliateLink = await page.evaluate(() => {
      // Try inputs with values
      const inputs = Array.from(document.querySelectorAll('input'));
      for (const input of inputs) {
        if (input.value && (
          input.value.includes('extrape') ||
          input.value.includes('fkrt') ||
          input.value.includes('amzn') ||
          input.value.includes('http')
        )) return input.value;
      }
      // Try anchor tags
      const links = Array.from(document.querySelectorAll('a'));
      for (const link of links) {
        if (link.href && (
          link.href.includes('extrape') ||
          link.href.includes('fkrt') ||
          link.href.includes('amzn')
        )) return link.href;
      }
      // Try elements with link-related classes
      const els = document.querySelectorAll('[class*="link"], [class*="result"], [class*="affiliate"], [class*="short"], [class*="copy"]');
      for (const el of els) {
        const text = el.value || el.textContent.trim();
        if (text && text.startsWith('http')) return text;
      }
      return null;
    });

    if (!affiliateLink) {
      throw new Error('Could not find affiliate link. Check screenshot 8_after_generate and logs above.');
    }

    console.log('Done [' + storeName + ']: ' + affiliateLink);
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

  try { new URL(url); } catch {
    return res.status(400).json({ error: 'Invalid URL format.' });
  }

  if (!isSupported(url)) {
    return res.status(400).json({
      error: 'This store is not supported. Try Amazon, Flipkart, Myntra, Ajio, Nykaa, or TataCliq.'
    });
  }

  if (!EXTRAPE_EMAIL || !EXTRAPE_PASSWORD) {
    return res.status(500).json({ error: 'Credentials not configured on the server.' });
  }

  try {
    const affiliateLink = await generateAffiliateLink(url, store || 'Unknown');
    return res.json({ affiliateLink, store: store || 'Unknown' });
  } catch (err) {
    console.error('Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── Debug endpoint: view screenshots list ──
app.get('/debug', (req, res) => {
  try {
    const files = fs.readdirSync('/tmp').filter(f => f.startsWith('debug_'));
    res.json({ screenshots: files, message: 'These are saved at /tmp/ on the server' });
  } catch(e) {
    res.json({ error: e.message });
  }
});

app.get('/', (req, res) => res.send('Smart Pick Deals backend running'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Server on port ' + PORT);
});