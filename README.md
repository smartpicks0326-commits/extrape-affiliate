# AffiLink — ExtraPe Affiliate Link Generator

A public web app that lets anyone paste an Amazon URL and receive your ExtraPe affiliate link instantly.

---

## Project Structure

```
extrape-app/
├── index.html     ← Frontend (deploy to Cloudflare Pages)
├── server.js      ← Backend (deploy to Render.com)
├── package.json   ← Node.js dependencies
└── README.md
```

---

## STEP 1 — Deploy Backend to Render.com (Free)

1. **Create a free account** at https://render.com

2. **Push this project to GitHub**
   ```bash
   git init
   git add .
   git commit -m "initial commit"
   # Create a repo on GitHub, then:
   git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO.git
   git push -u origin main
   ```

3. **Create a new Web Service on Render:**
   - Click **New → Web Service**
   - Connect your GitHub repo
   - Set these values:
     | Field | Value |
     |-------|-------|
     | Name | `extrape-affiliate` |
     | Runtime | `Node` |
     | Build Command | `npm install` |
     | Start Command | `npm start` |
     | Instance Type | `Free` |

4. **Add Environment Variables** (in Render dashboard → Environment tab):
   ```
   EXTRAPE_EMAIL    = your-extrape-email@example.com
   EXTRAPE_PASSWORD = your-extrape-password
   ```

5. Click **Deploy**. Once deployed, copy your backend URL — it will look like:
   ```
   https://extrape-affiliate.onrender.com
   ```

---

## STEP 2 — Update Frontend with Backend URL

Open `index.html` and find this line near the bottom:

```js
const BACKEND_URL = 'https://YOUR-APP-NAME.onrender.com/generate';
```

Replace it with your actual Render URL:

```js
const BACKEND_URL = 'https://extrape-affiliate.onrender.com/generate';
```

---

## STEP 3 — Deploy Frontend to Cloudflare Pages (Free)

1. **Go to** https://dash.cloudflare.com → **Pages → Create a project**
2. Connect your GitHub repo (same repo as above)
3. Set:
   | Field | Value |
   |-------|-------|
   | Framework preset | `None` |
   | Root directory | `/` |
   | Build command | *(leave empty)* |
   | Output directory | `/` |
4. Click **Save and Deploy**

Your site will be live at: `https://YOUR-PROJECT.pages.dev`

---

## STEP 4 — Update Puppeteer Selectors (Important!)

The `server.js` file uses CSS selectors to find elements on ExtraPe's website. You need to verify these match ExtraPe's actual UI:

1. Log into ExtraPe manually in Chrome
2. Go to the page where you paste Amazon URLs
3. Right-click on the **input field** → Inspect → copy its `id` or `name` attribute
4. Right-click on the **Generate/Convert button** → Inspect → copy its selector
5. Right-click on the **output link area** → Inspect → copy its selector

Then update these 3 sections in `server.js`:

```js
// Input field selector (line ~60)
await page.waitForSelector('YOUR_INPUT_SELECTOR');

// Submit button selector (line ~68)
await page.click('YOUR_BUTTON_SELECTOR');

// Output link selector (line ~72)
await page.waitForSelector('YOUR_OUTPUT_SELECTOR');
```

---

## How It Works

```
User pastes Amazon URL on your web app
          ↓
Cloudflare Pages serves the frontend (free)
          ↓
Frontend calls POST /generate on Render backend
          ↓
Puppeteer opens ExtraPe in a headless browser
  → Logs in with your credentials
  → Pastes the Amazon URL
  → Clicks generate
  → Extracts affiliate link
          ↓
Affiliate link returned to user's browser
```

---

## Notes

- **Render free tier** spins down after 15 mins of inactivity. First request after idle may take ~30 seconds.
- ExtraPe credentials are stored as **environment variables** on Render — never in code.
- If ExtraPe updates their website UI, you may need to update the CSS selectors in `server.js`.


For updating tokens + Tag Updater - bash ~/update-tokens.sh

After reboot logs - cat /home/smartpick/startup.log

sudo env PATH=$PATH:/usr/bin /usr/lib/node_modu





Product URL (any supported store)
Convert →
Detected: Amazon
Link ready
https://www.amazon.in/dp/B0DYVPP86H

If i copy the link, its looks good and if i click open - https://smartpickdeals.live/go/aHR0cHM6Ly93d3cuYW1hem9uLmluL2RwL0IwRFlWUFA4Nkg_dGFnPXNtYXJ0cGlja2RlMDktMjE
Connection timed out Error code 522
Visit cloudflare.com for more information.
2026-04-20 08:26:12 UTC

We have fixed this error before, please check the below one its works good before updatin the code today

// Cloudflare Pages Function: smartpickdeals.live/go/:code

// 1. Decodes base64url affiliate URL

// 2. Fires click tracking to Render (async, doesn't delay redirect)

// 3. Immediately 302 redirects user to affiliate URL

const BACKEND = 'https://extrape-affiliate.onrender.com';

export async function onRequest(context) {

  const code = context.params.code;

  if (!code) return new Response('Missing code', { status: 400 });

  let dest = null;

  // Decode base64url → affiliate URL

  try {

    const decoded = atob(code.replace(/-/g, '+').replace(/_/g, '/'));

    if (decoded.startsWith('http')) dest = decoded;

  } catch(e) {}

  if (!dest) {

    // Fallback: send to Render directly

    return Response.redirect(`${BACKEND}/go/${code}`, 302);

  }

  // Fire tracking in background (don't await — instant redirect)

  context.waitUntil(

    fetch(`${BACKEND}/track/click`, {

      method: 'POST',

      headers: { 'Content-Type': 'application/json' },

      body: JSON.stringify({ dest }),

    }).catch(() => {}) // silently ignore if Render is sleeping

  );

  // Instant redirect — no waiting for Render

  return Response.redirect(dest, 302);

}





2. Recent Go link clicks
DestinationStoreTime
https://www.amazon.in/dp/B0DYVPP86H—20 Apr, 01:18 pmhttps://www.amazon.in/dp/B0DYVPP86H—20 Apr, 01:16 pmhttps://www.amazon.in/dp/B0DYVPP86H—20 Apr, 01:09 pmhttps://www.amazon.in/dp/B0DYVPP86H—20 Apr, 01:00 pmhttps://www.amazon.in/dp/B0DYVPP86H—20 Apr, 12:59 pmhttps://www.amazon.in/dp/B0DYVPP86H—20 Apr, 12:55 pmhttps://www.amazon.in/dp/B0DYVPP86H—20 Apr, 11:31 amhttps://fkrt.co/J1NcPE—20 Apr, 11:30 amhttps://www.amazon.in/dp/B0DYVPP86H—20 Apr, 11:23 amhttps://www.amazon.in/dp/B0DYVPP86H—20 Apr, 11:23 am

Update store name Recent Go link clicks


4. Could I get the Smart Pick Deals logo from https://www.smartpickdeals.live/ in PNG format for use as a company logo?


5. It appears that when the server was down, the request was not redirected to Render as expected.

Example:

When the server is down:
	•	Product URL (any supported store): https://dl.flipkart.com/s/wdMG!GNNNN
	•	Convert →
	•	Detected: Flipkart
	•	Warning: Failed to fetch

When the server is available:
	•	Product URL (any supported store): https://dl.flipkart.com/s/wdMG!GNNNN
	•	Convert →
	•	Detected: Flipkart
	•	Link ready: https://fkrt.co/z677Fc

This suggests the fallback to Render may not be functioning correctly when the primary server is unavailable.