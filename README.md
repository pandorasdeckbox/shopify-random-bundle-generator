# Shopify Random Bundle Generator

Embedded Shopify app for Pandora's Deck Box. Generates randomized MTG booster pack bundles for:

- **Chaos Club** — 3 / 6 / 9 / 12 pack subscriptions with D20 collector upgrade system
- **Chaos Draft Kit** — 12 regular + 1 collector pack
- **Advent Calendar** — 23 regular + 1 collector pack

Outputs a printable DOCX packing slip, tracks Chaos Club subscribers, and can auto-generate bundles when subscription orders are paid via webhook.

---

## Setup Guide

> **Heads up on order of operations:** You need the Railway URL before you can finish configuring the Shopify app, but you need the Shopify API key before Railway can talk to Shopify. The trick is to create the Shopify app first (you'll get the key immediately), deploy to Railway second, then come back and paste the Railway URL into the Shopify app config.

---

### 1. Create the Shopify App (Dev Dashboard)

1. Go to [dev dashboard](https://shopify.dev/) and sign in with your Partner account
2. Click **Apps** in the left sidebar → **Create app**
3. On the "Create an app" screen, use the **Start from Dev Dashboard** panel on the right (not the CLI option)
4. Type `Bundle Generator` in the App name field → click **Create**
5. You'll land on your new app's overview page. Click **Configuration** in the left nav

**In the Configuration tab:**

6. Under **URLs**, set:
   - **App URL**: `https://placeholder.up.railway.app` *(you'll replace this after Railway deploy)*
   - **Allowed redirection URL**: `https://placeholder.up.railway.app/auth/callback` *(same — update later)*
7. Click **Save** at the bottom

**Add API scopes:**

8. Still in Configuration, find the **API access** or **Scopes** section. Add the following:
   ```
   read_products
   write_inventory
   read_inventory
   read_orders
   read_customers
   ```
9. Save again

**Get your credentials:**

10. Click **API credentials** (or **Overview**) in the left nav
11. Copy your **Client ID** (API key) and **Client secret** — you'll need both for Railway

---

### 2. Deploy to Railway

1. Go to [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub repo**
2. Select `pandorasdeckbox/shopify-random-bundle-generator`
3. Railway will auto-detect the `Procfile` and start the build with `node server.js`
4. Add a **PostgreSQL** database: in your project, click **+ New** → **Database** → **Add PostgreSQL**
   - Railway will automatically inject `DATABASE_URL` into your app's environment
5. Click on your app service → **Variables** tab → add the following:

```
SHOPIFY_API_KEY=        (Client ID from step 1.11)
SHOPIFY_API_SECRET=     (Client secret from step 1.11)
APP_URL=                (your Railway URL, e.g. https://bundle-generator-production.up.railway.app)
SHOPIFY_WEBHOOK_SECRET= (same value as SHOPIFY_API_SECRET)
NODE_ENV=               production
```

6. Once deployed, copy the Railway URL from the **Settings** tab (or from the generated domain shown in the service card)

---

### 3. Update the Shopify App URLs

Now that you have the real Railway URL, go back to the dev dashboard:

1. Dev dashboard → **Apps** → Bundle Generator → **Configuration**
2. Update **App URL** to your real Railway URL: `https://your-actual-url.up.railway.app`
3. Update **Allowed redirection URL** to: `https://your-actual-url.up.railway.app/auth/callback`
4. Save

---

### 4. Install the App on Your Store

1. Use this URL in your browser (replace with your actual values):
   ```
   https://your-railway-url.up.railway.app/auth?shop=pandorasdeckbox.myshopify.com
   ```
2. Shopify will show a permissions screen — click **Install**
3. You'll be redirected back to the app UI

> If you see an error about the redirect URI not matching, double-check step 3 above — the URL in Shopify's config must exactly match (no trailing slash, correct domain).

### 5. Configure the App

Once installed, the app UI should open automatically. If not, visit:
`https://your-railway-url.up.railway.app/app?shop=pandorasdeckbox.myshopify.com`

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
