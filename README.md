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


sudo env PATH=$PATH:/usr/bin /usr/lib/node_modu