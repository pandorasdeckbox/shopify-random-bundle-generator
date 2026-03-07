# Shopify Random Bundle Generator

Embedded Shopify app for Pandora's Deck Box. Generates randomized MTG booster pack bundles for:

- **Chaos Club** — 3 / 6 / 9 / 12 pack subscriptions with D20 collector upgrade system
- **Chaos Draft Kit** — 12 regular + 1 collector pack
- **Advent Calendar** — 23 regular + 1 collector pack

Outputs a printable DOCX packing slip, tracks Chaos Club subscribers, and can auto-generate bundles when subscription orders are paid via webhook.

---

## Setup Guide

### 1. Create a Shopify App in Partner Dashboard

1. Go to [partners.shopify.com](https://partners.shopify.com) → **Apps** → **Create app** → **Custom app**
2. Name it "Bundle Generator" (or whatever you like)
3. Under **Configuration**, set:
   - **App URL**: `https://your-railway-app.up.railway.app`
   - **Allowed redirection URL**: `https://your-railway-app.up.railway.app/auth/callback`
4. Under **API access**, ensure these scopes are requested:
   - `read_products`, `write_inventory`, `read_inventory`
   - `read_orders`, `read_all_orders`, `read_customers`
5. Note your **API key** and **API secret key**

### 2. Deploy to Railway

1. Go to [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub repo**
2. Select `pandorasdeckbox/shopify-random-bundle-generator`
3. Railway will auto-detect the `Procfile` and deploy with `node server.js`
4. Add a **PostgreSQL** plugin: click **+ New** → **Database** → **Add PostgreSQL**
5. Set these environment variables in Railway's **Variables** tab:

```
SHOPIFY_API_KEY=       your api key from Partner Dashboard
SHOPIFY_API_SECRET=    your api secret from Partner Dashboard
APP_URL=               https://your-railway-app.up.railway.app
SHOPIFY_WEBHOOK_SECRET= same as SHOPIFY_API_SECRET
NODE_ENV=production
```

Railway sets `DATABASE_URL` automatically when you add the PostgreSQL plugin — you don't need to set that one.

6. After deploy succeeds, copy your Railway URL and paste it back into the Shopify Partner Dashboard as the **App URL** and **redirect URL** (step 1.3 above)

### 3. Install the App on Your Store

1. In Partner Dashboard → **Apps** → your app → **Test on development store** (or use the install URL)
2. Install URL format: `https://your-railway-app.up.railway.app/auth?shop=pandorasdeckbox.myshopify.com`
3. Approve the permission request in Shopify admin

### 4. Configure the App

Once installed, visit `https://your-railway-app.up.railway.app/app?shop=pandorasdeckbox.myshopify.com`

**Settings tab:**
- Set subscription prices for 3 / 6 / 9 / 12-pack tiers
- Set Advent Calendar and Draft Kit prices
- Set margin targets (default 40%)
- Find your **Chaos Club Product** — go to the product in Shopify admin, look at the URL for the numeric ID (e.g. `1234567890`), enter it as `gid://shopify/Product/1234567890`
- Click **Register Webhook** — this lets the app auto-generate bundles when subscriptions renew

**Products tab:**
- Check **Regular** for all packs eligible for regular slots
- Check **Collector** for foil/special/collector packs
- A product can be both Regular and Collector (it'll appear in either pool)
- Click **Save Product Settings**

**Subscribers tab:**
- Add all your current Chaos Club subscribers
- Fill in their pack count, start date, months renewed, and last D20 upgrade date (this seeds the luck protection system)

---

## Local Development

### Prerequisites
- Node.js 18+
- A Shopify Partner account and dev store
- [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) (`cloudflared`)

### Setup

```bash
cd shopify-random-bundle-generator
npm install

# If better-sqlite3 fails to compile on Python 3.12+:
pip3 install setuptools
npm rebuild better-sqlite3
npm rebuild sqlite3

cp .env.example .env
# Fill in .env with your dev app credentials
```

Start the tunnel first (Shopify requires HTTPS):

```bash
npm run tunnel
# Copy the https://xxxx.trycloudflare.com URL
```

Update `APP_URL` in `.env` to the tunnel URL, also update the App URL and redirect URL in Partner Dashboard.

Then start the server:

```bash
npm start
```

---

## How It Works

### D20 Upgrade System (Chaos Club)
- Every bundle generation for Chaos Club rolls a d20
- Roll of **20** = one pack is upgraded from regular to collector tier
- **Luck protection**: if it's been 12+ months since the last upgrade, any roll of **15 or higher** triggers an upgrade
- The upgrade date is tracked per subscriber and factored in automatically

### Bundle Scoring
Bundles are scored on:
1. **Margin proximity** — how close the total cost gets to the target margin
2. **Variety** — penalty for repeating the same pack more than once

200 attempts are made (300 for Advent) and the best-scoring bundle is returned.

### Auto-Webhook
When an `orders/paid` webhook fires:
1. The order's line items are checked for the configured Chaos Club Product ID
2. If found, the subscriber is looked up by Shopify customer ID
3. A bundle is generated and inventory is **immediately decremented** (not a dry run)
4. The bundle is saved to history
5. The subscriber's `months_renewed` counter is updated

The DOCX packing slip must be downloaded manually from the History tab after the webhook fires.

### Inventory Updates
Uses Shopify's `inventory_levels/adjust` REST endpoint with `available_adjustment: -N` — an atomic delta that won't cause race conditions.

---

## Project Structure

```
server.js           — Express server, OAuth, all API routes, webhook handler
database.js         — PostgreSQL + SQLite dual-database abstraction
bundleGenerator.js  — Bundle generation logic (ported from chaos_club_generator.py)
docxGenerator.js    — DOCX packing slip generation
public/index.html   — Single-page embedded app UI (5 tabs)
```

---

## License

MIT
