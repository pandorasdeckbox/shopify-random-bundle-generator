/**
 * Shopify Random Bundle Generator — Embedded App Server
 *
 * Generates randomized MTG booster pack bundles for:
 *   - Chaos Club subscriptions (3/6/9/12 packs + D20 upgrade system)
 *   - Chaos Draft Kits (12 regular + 1 collector)
 *   - Advent Calendars (23 regular + 1 collector)
 *
 * Authentication: Custom OAuth (bypasses iframe cookie restrictions)
 * Storage: PostgreSQL (Railway prod) / SQLite (local dev)
 * Webhooks: orders/paid — auto-triggers bundle on Chaos Club subscription renewal
 */

import express from 'express';
import { shopifyApi, LogSeverity, ApiVersion, Session } from '@shopify/shopify-api';
import '@shopify/shopify-api/adapters/node';
import dotenv from 'dotenv';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  initDatabase,
  sessionStorage as getSessionStorage,
  getSettings,
  saveSettings,
  getDefaultSettings,
  getSubscribers,
  getSubscriber,
  getSubscriberByCustomerId,
  createSubscriber,
  updateSubscriber,
  deleteSubscriber,
  saveBundleHistory,
  getBundleHistory,
  getBundleById,
  saveDOCXTemplate,
  getDOCXTemplate,
  deleteDOCXTemplate,
} from './database.js';

import {
  fetchAllProducts,
  fetchBundleProducts,
  fetchCollections,
  generateSubscriptionBundle,
  generateAdventBundle,
  generateDraftKitBundle,
  updateInventory,
  calculateMonthsSince,
  gidToNumeric,
} from './bundleGenerator.js';

import { generateBundleDocx, generateBundleDocxFromTemplate, bundleFilename } from './docxGenerator.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── Init DB first, then everything else ─────────────────────────────────────

// ─── Startup env var check ──────────────────────────────────────────────────

const REQUIRED_ENV = ['SHOPIFY_API_KEY', 'SHOPIFY_API_SECRET', 'APP_URL'];
const missing = REQUIRED_ENV.filter(k => !process.env[k]);
if (missing.length) {
  console.error(`\n❌ Missing required environment variables: ${missing.join(', ')}`);
  console.error('   Set these in Railway → your service → Variables, then redeploy.\n');
  process.exit(1);
}

await initDatabase();

// db.js exports sessionStorage after initDatabase() populates it

// ─── Logger ────────────────────────────────────────────────────────────────────
function log(level, msg, data = {}) {
  const ts = new Date().toISOString();
  const icons = { INFO: '📋', WARN: '⚠️ ', ERROR: '❌', SUCCESS: '✅', DEBUG: '🔍' };
  const icon = icons[level] ?? '  ';
  const dataStr = Object.keys(data).length ? ' ' + JSON.stringify(data) : '';
  console.log(`[${ts}] ${icon} [${level}] ${msg}${dataStr}`);
}
import { sessionStorage } from './database.js';

const app = express();
const PORT = process.env.PORT || 3000;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

// In-memory OAuth state (avoids cookie issues in embedded iframes)
const oauthStateStorage = new Map();

// ─── Shopify API Setup ────────────────────────────────────────────────────────

const shopify = shopifyApi({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET,
  scopes: ['read_products', 'write_inventory', 'read_inventory', 'read_orders', 'read_customers'],
  hostName: process.env.APP_URL?.replace(/https?:\/\//, '') || 'localhost',
  hostScheme: 'https',
  apiVersion: ApiVersion.January24,
  isEmbeddedApp: true,
  sessionStorage,
  logger: { level: IS_PRODUCTION ? LogSeverity.Warning : LogSeverity.Debug },
  useOnlineTokens: false,
});

// ─── Middleware ───────────────────────────────────────────────────────────────

// Raw body for webhook HMAC verification — must come before express.json()
app.use('/webhooks', express.raw({ type: 'application/json' }));

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

if (IS_PRODUCTION) app.set('trust proxy', 1);

// ─── Health Check ─────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

// ─── Serve App Shell ──────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  if (!req.query.shop) return res.status(400).send('Missing shop parameter');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/app', async (req, res) => {
  const { shop, host } = req.query;
  if (!shop) return res.status(400).send('Missing shop parameter');

  const sanitizedShop = shopify.utils.sanitizeShop(shop);
  if (!sanitizedShop) return res.status(400).send('Invalid shop parameter');

  const session = await sessionStorage.loadSession(`offline_${sanitizedShop}`);
  if (!session) {
    // Must break out of Shopify's iframe before redirecting to OAuth
    const authUrl = `/auth?shop=${encodeURIComponent(sanitizedShop)}${host ? `&host=${encodeURIComponent(String(host))}` : ''}`;
    return res.send(`<!DOCTYPE html><html><head><script>window.top.location.href=${JSON.stringify(authUrl)};<\/script></head><body>Redirecting...</body></html>`);
  }

  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Exit iFrame (needed for embedded OAuth) ──────────────────────────────────

app.get('/exitiframe', (req, res) => {
  const { shop } = req.query;
  if (!shop) return res.status(400).send('Missing shop parameter');
  const sanitizedShop = shopify.utils.sanitizeShop(shop);
  if (!sanitizedShop) return res.status(400).send('Invalid shop parameter');
  const redirectUri = `https://${sanitizedShop}/admin/apps/${process.env.SHOPIFY_API_KEY}/auth?shop=${encodeURIComponent(sanitizedShop)}`;
  res.send(`<!DOCTYPE html><html><head><script>window.top.location.href=${JSON.stringify(redirectUri)};</script></head><body>Redirecting...</body></html>`);
});

// ─── OAuth ────────────────────────────────────────────────────────────────────

app.get('/auth', async (req, res) => {
  try {
    const shop = req.query.shop;
    if (!shop) return res.status(400).send('Missing shop parameter');

    const sanitizedShop = shopify.utils.sanitizeShop(shop, true);
    const state = crypto.randomBytes(16).toString('hex');
    oauthStateStorage.set(sanitizedShop, state);

    const authUrl = `https://${sanitizedShop}/admin/oauth/authorize?` + new URLSearchParams({
      client_id: process.env.SHOPIFY_API_KEY,
      scope: 'read_products,write_inventory,read_inventory,read_orders,read_customers',
      redirect_uri: `${process.env.APP_URL}/auth/callback`,
      state,
    }).toString();

    res.redirect(authUrl);
  } catch (err) {
    console.error('Auth error:', err);
    res.status(500).send('Authentication failed: ' + err.message);
  }
});

app.get('/auth/callback', async (req, res) => {
  try {
    const { shop, code, state } = req.query;
    if (!shop || !code || !state) throw new Error('Missing required OAuth parameters');

    const sanitizedShop = shopify.utils.sanitizeShop(shop, true);

    // Verify state (CSRF protection)
    const storedState = oauthStateStorage.get(sanitizedShop);
    if (storedState !== state) throw new Error('Invalid OAuth state parameter');
    oauthStateStorage.delete(sanitizedShop);

    // Exchange code for access token
    const tokenResponse = await fetch(`https://${sanitizedShop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: process.env.SHOPIFY_API_KEY,
        client_secret: process.env.SHOPIFY_API_SECRET,
        code,
      }),
    });
    if (!tokenResponse.ok) throw new Error(`Token exchange failed: ${tokenResponse.statusText}`);
    const { access_token, scope } = await tokenResponse.json();

    // Save session
    const sessionId = `offline_${sanitizedShop}`;
    await sessionStorage.deleteSession(sessionId);
    const session = new Session({ id: sessionId, shop: sanitizedShop, state, isOnline: false, accessToken: access_token, scope });
    await sessionStorage.storeSession(session);

    console.log('✅ OAuth complete for', sanitizedShop);

    // Redirect back into Shopify admin so the app re-embeds in the iframe.
    // Going to /app standalone would load outside Shopify admin.
    res.redirect(`https://${sanitizedShop}/admin/apps/${process.env.SHOPIFY_API_KEY}`);
  } catch (err) {
    console.error('OAuth callback error:', err.message);
    res.status(500).send('Authentication callback failed: ' + err.message);
  }
});

// ─── Session Middleware ───────────────────────────────────────────────────────

async function verifySession(req, res, next) {
  const rawShop = req.query.shop || req.body?.shop;
  if (!rawShop) return res.status(401).json({ error: 'Missing shop parameter', needsReauth: true });

  const shop = shopify.utils.sanitizeShop(rawShop);
  if (!shop) return res.status(401).json({ error: 'Invalid shop parameter', needsReauth: true });

  const session = await sessionStorage.loadSession(`offline_${shop}`);
  if (!session) {
    log('WARN', `No session found for shop: ${shop}`);
    return res.status(401).json({ error: 'No session found', needsReauth: true, authUrl: `/auth?shop=${encodeURIComponent(shop)}` });
  }

  log('INFO', `Session verified`, { shop });
  req.shopifySession = session;
  next();
}

// ─── API: Shop Info ───────────────────────────────────────────────────────────

app.get('/api/shop', verifySession, async (req, res) => {
  try {
    const client = new shopify.clients.Rest({ session: req.shopifySession });
    const response = await client.get({ path: 'shop' });
    res.json(response.body.shop);
  } catch (err) {
    console.error('Error fetching shop:', err.message);
    res.status(500).json({ error: 'Failed to fetch shop info' });
  }
});

// ─── API: Products (for configuration UI) ────────────────────────────────────

app.get('/api/products', verifySession, async (req, res) => {
  try {
    const client = new shopify.clients.Graphql({ session: req.shopifySession });
    const products = await fetchAllProducts(client);
    res.json({ products });
  } catch (err) {
    console.error('Error fetching products:', err.message);
    res.status(500).json({ error: 'Failed to fetch products' });
  }
});

app.get('/api/collections', verifySession, async (req, res) => {
  try {
    const client = new shopify.clients.Graphql({ session: req.shopifySession });
    const collections = await fetchCollections(client);
    res.json({ collections });
  } catch (err) {
    console.error('Error fetching collections:', err.message);
    res.status(500).json({ error: 'Failed to fetch collections' });
  }
});

// ─── API: Settings ────────────────────────────────────────────────────────────

app.get('/api/settings', verifySession, async (req, res) => {
  try {
    const settings = await getSettings(req.shopifySession.shop);
    res.json({ settings });
  } catch (err) {
    console.error('Error fetching settings:', err.message);
    res.status(500).json({ error: 'Failed to fetch settings' });
  }
});

app.post('/api/settings', verifySession, async (req, res) => {
  try {
    const current = await getSettings(req.shopifySession.shop);
    const merged = { ...current, ...req.body.settings };
    await saveSettings(req.shopifySession.shop, merged);
    res.json({ success: true, settings: merged });
  } catch (err) {
    console.error('Error saving settings:', err.message);
    res.status(500).json({ error: 'Failed to save settings' });
  }
});

// ─── API: Generate Bundle ─────────────────────────────────────────────────────

app.post('/api/generate', verifySession, async (req, res) => {
  try {
    const shop = req.shopifySession.shop;
    const {
      bundle_type,   // 'chaos_club' | 'advent' | 'draft_kit'
      pack_count,    // 3 | 6 | 9 | 12 (chaos_club only)
      customer_name,
      subscriber_id,
      d20_enabled,
      last_upgrade_date,
      dry_run = true,
    } = req.body;

    log('INFO', `Bundle generation requested`, { shop, bundle_type, pack_count, subscriber_id, dry_run, customer_name });

    const settings = await getSettings(shop);

    // If subscriber_id provided, merge subscriber defaults
    let resolvedName = customer_name || 'Customer';
    let resolvedPackCount = pack_count;
    let resolvedLastUpgrade = last_upgrade_date;

    if (subscriber_id) {
      const sub = await getSubscriber(shop, subscriber_id);
      if (sub) {
        resolvedName = customer_name || sub.name;
        resolvedPackCount = pack_count || sub.pack_count;
        resolvedLastUpgrade = last_upgrade_date || sub.last_upgrade_date;
      }
    }

    // Fetch products with costs
    const { regular, collector } = await fetchBundleProducts(
      new shopify.clients.Graphql({ session: req.shopifySession }),
      settings.regular_pack_ids || [],
      settings.collector_pack_ids || []
    );

    if (!regular.length) {
      return res.status(400).json({ error: 'No regular packs configured. Go to Products tab and select eligible packs.' });
    }

    // Generate bundle based on type
    let result;
    const typeLabel = { chaos_club: 'Chaos Club', advent: 'Advent Calendar', draft_kit: 'Chaos Draft Kit' }[bundle_type] || bundle_type;

    if (bundle_type === 'chaos_club') {
      result = generateSubscriptionBundle(regular, collector, resolvedPackCount, settings, {
        enabled: !!d20_enabled,
        lastUpgradeDate: resolvedLastUpgrade || null,
      });
    } else if (bundle_type === 'advent') {
      result = generateAdventBundle(regular, collector, settings);
    } else if (bundle_type === 'draft_kit') {
      result = generateDraftKitBundle(regular, collector, settings);
    } else {
      return res.status(400).json({ error: 'Unknown bundle_type' });
    }

    if (!result) {
      log('WARN', `Bundle generation failed — no valid bundle found`, { shop, bundle_type, pack_count: resolvedPackCount });
      return res.status(422).json({ error: 'Could not generate a bundle meeting margin requirements. Check product inventory and pricing.' });
    }

    // Log generated bundle details
    log('INFO', `Bundle generated`, {
      bundle_type,
      customer: resolvedName,
      packs: result.packs.length,
      margin_pct: result.metrics.margin_percent?.toFixed(1) + '%',
      total_cost: result.metrics.total_cost?.toFixed(2),
      total_retail: result.metrics.total_retail?.toFixed(2),
      target_price: result.metrics.target_price?.toFixed(2),
      d20: result.d20Result?.roll ?? null,
      d20_upgraded: result.d20Result?.upgraded ?? false,
      dry_run,
    });
    for (const pack of result.packs) {
      log('DEBUG', `  Pack: ${pack.product_title}`, { cost: pack.cost, retail: pack.retail, collector: !!pack.isCollector });
    }

    // Update inventory (or dry run)
    const inventoryResults = await updateInventory(shopify, req.shopifySession, result.packs, dry_run);
    const invFailed = inventoryResults.filter(r => !r.success);
    log(dry_run ? 'INFO' : 'SUCCESS', `Inventory ${dry_run ? 'dry-run' : 'LIVE update'} complete`, {
      updated: inventoryResults.filter(r => r.success).length,
      failed: invFailed.length,
      results: inventoryResults.map(r => ({
        name: r.name,
        success: r.success,
        ...(r.success ? { from: r.from, to: r.to, qty: r.qty } : { reason: r.reason }),
        ...(r.lowStock ? { lowStock: true } : {}),
      })),
    });
    if (invFailed.length) {
      log('WARN', `${invFailed.length} inventory update(s) failed`, { failed: invFailed.map(r => ({ name: r.name, reason: r.reason })) });
    }

    // Persist bundle to history
    const d20Result = result.d20Result;
    const saved = await saveBundleHistory(shop, {
      subscriber_id: subscriber_id || null,
      bundle_type: typeLabel,
      customer_name: resolvedName,
      pack_count: result.packs.length,
      total_cost: result.metrics.total_cost,
      total_retail: result.metrics.total_retail,
      target_price: result.metrics.target_price,
      margin_percent: result.metrics.margin_percent,
      d20_roll: d20Result?.roll || null,
      d20_upgraded: d20Result?.upgraded || false,
      packs: result.packs,
      dry_run,
    });

    // If subscriber got a D20 upgrade, update their record
    if (subscriber_id && d20Result?.upgraded) {
      const sub = await getSubscriber(shop, subscriber_id);
      if (sub) {
        await updateSubscriber(shop, subscriber_id, {
          ...sub,
          collector_upgrade_count: (sub.collector_upgrade_count || 0) + 1,
          last_upgrade_date: new Date().toISOString().slice(0, 10),
        });
        log('INFO', `D20 upgrade recorded for subscriber`, { subscriber_id, roll: d20Result.roll });
      }
    }

    // If subscriber and LIVE run, increment months_renewed
    if (subscriber_id && !dry_run) {
      const sub = await getSubscriber(shop, subscriber_id);
      if (sub) {
        await updateSubscriber(shop, subscriber_id, {
          ...sub,
          months_renewed: (sub.months_renewed || 0) + 1,
        });
        log('INFO', `months_renewed incremented to ${(sub.months_renewed || 0) + 1}`, { subscriber_id });
      }
    }

    log('SUCCESS', `Bundle #${saved.id} saved${dry_run ? ' [DRY RUN]' : ' [LIVE]'}`, { bundle_id: saved.id, customer: resolvedName });

    res.json({
      success: true,
      bundle_id: saved.id,
      bundle_type: typeLabel,
      customer_name: resolvedName,
      packs: result.packs,
      metrics: result.metrics,
      d20: d20Result,
      inventory_results: inventoryResults,
      dry_run,
    });
  } catch (err) {
    console.error('Error generating bundle:', err.message, err.stack);
    res.status(500).json({ error: 'Bundle generation failed: ' + err.message });
  }
});

// ─── API: Download DOCX ───────────────────────────────────────────────────────

app.get('/api/bundles/:id/docx', verifySession, async (req, res) => {
  try {
    const shop = req.shopifySession.shop;
    const bundle = await getBundleById(shop, req.params.id);
    if (!bundle) return res.status(404).json({ error: 'Bundle not found' });

    const packs = typeof bundle.packs_json === 'string' ? JSON.parse(bundle.packs_json) : bundle.packs_json;

    const bundleData = {
      packs,
      targetPrice: parseFloat(bundle.target_price),
      metrics: {
        total_cost: parseFloat(bundle.total_cost),
        total_retail: parseFloat(bundle.total_retail),
        target_price: parseFloat(bundle.target_price),
        margin_dollars: parseFloat(bundle.target_price) - parseFloat(bundle.total_cost),
        margin_percent: parseFloat(bundle.margin_percent),
      },
      d20Result: bundle.d20_roll ? {
        roll: bundle.d20_roll,
        upgraded: bundle.d20_upgraded === true || bundle.d20_upgraded === 1,
      } : null,
    };

    const isDryRun = bundle.dry_run === true || bundle.dry_run === 1;
    const filename = bundleFilename(bundle.bundle_type, bundle.customer_name);

    // Use uploaded template if one exists, otherwise fall back to built-in layout
    const template = await getDOCXTemplate(shop);
    const docxBuffer = template
      ? await generateBundleDocxFromTemplate(template.buffer, bundleData, bundle.customer_name, bundle.bundle_type, isDryRun)
      : await generateBundleDocx(bundleData, bundle.customer_name, bundle.bundle_type, isDryRun);

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(docxBuffer);
  } catch (err) {
    console.error('Error generating DOCX:', err.message);
    res.status(500).json({ error: 'DOCX generation failed: ' + err.message });
  }
});

// ─── API: DOCX Template ───────────────────────────────────────────────────────

app.get('/api/template/status', verifySession, async (req, res) => {
  try {
    const template = await getDOCXTemplate(req.shopifySession.shop);
    res.json({ hasTemplate: !!template, filename: template?.filename || null });
  } catch (err) {
    res.status(500).json({ error: 'Failed to check template status' });
  }
});

app.post('/api/template', verifySession, async (req, res) => {
  try {
    const { data, filename } = req.body;
    if (!data) return res.status(400).json({ error: 'No template data provided' });
    const buffer = Buffer.from(data, 'base64');
    if (buffer.length > 5 * 1024 * 1024) return res.status(400).json({ error: 'Template too large (max 5MB)' });
    await saveDOCXTemplate(req.shopifySession.shop, buffer, filename || 'template.docx');
    res.json({ success: true });
  } catch (err) {
    console.error('Error saving template:', err.message);
    res.status(500).json({ error: 'Failed to save template: ' + err.message });
  }
});

app.delete('/api/template', verifySession, async (req, res) => {
  try {
    await deleteDOCXTemplate(req.shopifySession.shop);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete template' });
  }
});

// ─── API: Inventory ───────────────────────────────────────────────────────────

app.post('/api/inventory/set', verifySession, async (req, res) => {
  try {
    const { inventory_item_id, quantity } = req.body;
    if (!inventory_item_id || quantity === undefined || quantity === null) {
      return res.status(400).json({ error: 'inventory_item_id and quantity are required' });
    }
    const qty = parseInt(quantity, 10);
    if (isNaN(qty) || qty < 0 || qty > 99999) return res.status(400).json({ error: 'Invalid quantity' });

    const numericId = gidToNumeric(inventory_item_id);
    const client = new shopify.clients.Rest({ session: req.shopifySession });

    const levelsResp = await client.get({
      path: 'inventory_levels',
      query: { inventory_item_ids: numericId },
    });
    const levels = levelsResp.body?.inventory_levels;
    if (!levels?.length) return res.status(404).json({ error: 'No inventory level found' });

    const currentQty = levels[0].available;
    log('INFO', `Manual inventory set requested`, { inventory_item_id, current_qty: currentQty, new_qty: qty, location_id: levels[0].location_id });

    await client.post({
      path: 'inventory_levels/set',
      data: {
        location_id: levels[0].location_id,
        inventory_item_id: parseInt(numericId),
        available: qty,
      },
    });

    log('SUCCESS', `Manual inventory set complete`, { inventory_item_id, from: currentQty, to: qty });
    res.json({ success: true, available: qty });
  } catch (err) {
    console.error('Error setting inventory:', err.message);
    res.status(500).json({ error: 'Failed to set inventory: ' + err.message });
  }
});

// ─── API: Bundle History ──────────────────────────────────────────────────────

app.get('/api/bundles', verifySession, async (req, res) => {
  try {
    const history = await getBundleHistory(req.shopifySession.shop, parseInt(req.query.limit) || 50);
    res.json({ bundles: history });
  } catch (err) {
    console.error('Error fetching bundle history:', err.message);
    res.status(500).json({ error: 'Failed to fetch bundle history' });
  }
});

// ─── API: Subscribers ─────────────────────────────────────────────────────────

app.get('/api/subscribers', verifySession, async (req, res) => {
  try {
    const subs = await getSubscribers(req.shopifySession.shop);
    res.json({ subscribers: subs });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch subscribers' });
  }
});

app.post('/api/subscribers', verifySession, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    const sub = await createSubscriber(req.shopifySession.shop, req.body);
    res.json({ subscriber: sub });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create subscriber: ' + err.message });
  }
});

app.put('/api/subscribers/:id', verifySession, async (req, res) => {
  try {
    const sub = await updateSubscriber(req.shopifySession.shop, req.params.id, req.body);
    if (!sub) return res.status(404).json({ error: 'Subscriber not found' });
    res.json({ subscriber: sub });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update subscriber: ' + err.message });
  }
});

app.delete('/api/subscribers/:id', verifySession, async (req, res) => {
  try {
    await deleteSubscriber(req.shopifySession.shop, req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete subscriber: ' + err.message });
  }
});

// ─── API: Import Subscribers Preview ─────────────────────────────────────────

app.get('/api/subscribers/import-preview', verifySession, async (req, res) => {
  try {
    const shop = req.shopifySession.shop;
    const settings = await getSettings(shop);
    // Accept product_gid as a query param override (allows picking in modal without Settings pre-config)
    const chaosProductId = req.query.product_gid || settings.chaos_club_product_id;
    if (!chaosProductId) {
      return res.status(400).json({ error: 'No product selected.' });
    }

    // Extract numeric ID from GID
    const numericId = String(chaosProductId).split('/').pop();

    // Paginate through ALL orders using since_id (ascending by ID) — more reliable than Link headers
    const client = new shopify.clients.Rest({ session: req.shopifySession });
    const orderMap = new Map(); // customer_id -> aggregated data

    let sinceId = 0;
    let hasMore = true;
    while (hasMore) {
      const response = await client.get({
        path: 'orders',
        query: {
          limit: 250,
          status: 'any',
          created_at_min: '2018-01-01T00:00:00Z',
          since_id: sinceId,
          fields: 'id,created_at,customer,line_items',
        },
      });
      const orders = response.body.orders || [];

      for (const order of orders) {
        if (!order.customer) continue;
        const lineItem = (order.line_items || []).find(li => String(li.product_id) === numericId);
        if (!lineItem) continue;

        const custId = String(order.customer.id);
        const orderDate = new Date(order.created_at);

        // Parse pack count from variant title (e.g. "6 Pack", "6-Pack", "9 Pack")
        const variantTitle = lineItem.variant_title || '';
        const variantNum = parseInt(variantTitle.match(/\d+/)?.[0] || '0', 10);
        const snapPack = variantNum === 9 ? 9 : variantNum === 12 ? 12 : variantNum === 6 ? 6 : 3;

        if (!orderMap.has(custId)) {
          orderMap.set(custId, {
            shopify_customer_id: custId,
            name: `${order.customer.first_name || ''} ${order.customer.last_name || ''}`.trim() || `Customer ${custId}`,
            email: order.customer.email || null,
            pack_count: snapPack,
            first_order_date: order.created_at,
            months_renewed: 1,
          });
        } else {
          const existing = orderMap.get(custId);
          existing.months_renewed += 1;
          if (orderDate < new Date(existing.first_order_date)) {
            existing.first_order_date = order.created_at;
            existing.pack_count = snapPack;
          }
        }
      }

      if (orders.length === 250) {
        sinceId = orders[orders.length - 1].id;
      } else {
        hasMore = false;
      }
    }

    // Check which customers already exist as subscribers
    const existingSubs = await getSubscribers(shop);
    const existingIds = new Set(existingSubs.map(s => String(s.shopify_customer_id)).filter(Boolean));

    const candidates = Array.from(orderMap.values()).map(c => ({
      ...c,
      already_exists: existingIds.has(c.shopify_customer_id),
    }));

    // Sort: new first, then alphabetical
    candidates.sort((a, b) => {
      if (a.already_exists !== b.already_exists) return a.already_exists ? 1 : -1;
      return a.name.localeCompare(b.name);
    });

    res.json({ candidates });
  } catch (err) {
    console.error('Import preview error:', err.message);
    res.status(500).json({ error: 'Failed to fetch order history: ' + err.message });
  }
});

// ─── API: Import Subscribers Confirm ─────────────────────────────────────────

app.post('/api/subscribers/import', verifySession, async (req, res) => {
  try {
    const shop = req.shopifySession.shop;
    const { candidates } = req.body;
    if (!Array.isArray(candidates) || !candidates.length || candidates.length > 500) {
      return res.status(400).json({ error: 'No candidates provided' });
    }

    const existingSubs = await getSubscribers(shop);
    const existingIds = new Set(existingSubs.map(s => String(s.shopify_customer_id)).filter(Boolean));

    let imported = 0, skipped = 0;
    for (const c of candidates) {
      if (existingIds.has(String(c.shopify_customer_id))) { skipped++; continue; }
      await createSubscriber(shop, {
        name: c.name,
        email: c.email || null,
        shopify_customer_id: c.shopify_customer_id,
        pack_count: c.pack_count || 3,
        start_date: c.first_order_date ? c.first_order_date.slice(0, 10) : null,
        months_renewed: c.months_renewed || 0,
        collector_upgrade_count: 0,
        last_upgrade_date: null,
        status: 'active',
      });
      imported++;
    }

    res.json({ imported, skipped });
  } catch (err) {
    console.error('Import error:', err.message);
    res.status(500).json({ error: 'Import failed: ' + err.message });
  }
});

// ─── API: Register Webhooks ───────────────────────────────────────────────────

app.post('/api/register-webhooks', verifySession, async (req, res) => {
  try {
    const client = new shopify.clients.Rest({ session: req.shopifySession });

    // List existing webhooks
    const existing = await client.get({ path: 'webhooks' });
    const webhooks = existing.body.webhooks || [];
    const ordersWebhook = webhooks.find(w => w.topic === 'orders/paid' && w.address.includes('/webhooks/orders-paid'));

    if (ordersWebhook) {
      return res.json({ success: true, message: 'orders/paid webhook already registered', webhook: ordersWebhook });
    }

    // Register new webhook
    const result = await client.post({
      path: 'webhooks',
      data: {
        webhook: {
          topic: 'orders/paid',
          address: `${process.env.APP_URL}/webhooks/orders-paid`,
          format: 'json',
        },
      },
    });

    res.json({ success: true, message: 'Webhook registered', webhook: result.body.webhook });
  } catch (err) {
    console.error('Error registering webhooks:', err.message);
    res.status(500).json({ error: 'Failed to register webhooks: ' + err.message });
  }
});

// ─── Webhook: orders/paid ──────────────────────────────────────────────────────

app.post('/webhooks/orders-paid', async (req, res) => {
  // Verify HMAC signature
  const hmacHeader = req.headers['x-shopify-hmac-sha256'];
  const webhookSecret = process.env.SHOPIFY_WEBHOOK_SECRET || process.env.SHOPIFY_API_SECRET;

  if (!hmacHeader || !webhookSecret) {
    console.warn('⚠️  Webhook received without HMAC header or secret not configured');
    return res.status(401).send('Unauthorized');
  }

  const digest = crypto
    .createHmac('sha256', webhookSecret)
    .update(req.body)
    .digest('base64');

  if (!crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmacHeader))) {
    console.warn('⚠️  Webhook HMAC verification failed');
    return res.status(401).send('Unauthorized');
  }

  // Acknowledge quickly
  res.status(200).send('OK');

  // Process asynchronously
  try {
    const order = JSON.parse(req.body.toString());
    const rawShop = req.headers['x-shopify-shop-domain'];
    const shop = rawShop ? shopify.utils.sanitizeShop(rawShop) : null;

    if (!shop || !order) return;

    console.log(`📦 Webhook: orders/paid — Order ${order.name} for ${shop}`);

    const settings = await getSettings(shop);
    const chaosProductId = settings.chaos_club_product_id;
    if (!chaosProductId) return; // Not configured yet

    // Check if this order contains the Chaos Club subscription product
    const lineItems = order.line_items || [];
    const chaosItem = lineItems.find(item => {
      const gid = `gid://shopify/Product/${item.product_id}`;
      return gid === chaosProductId || String(item.product_id) === String(chaosProductId).split('/').pop();
    });

    if (!chaosItem) return;

    console.log(`🎲 Chaos Club renewal detected for customer ${order.customer?.id}`);

    // Look up subscriber
    const session = await sessionStorage.loadSession(`offline_${shop}`);
    if (!session) {
      console.error('No session found for shop', shop);
      return;
    }

    const subscriber = order.customer?.id
      ? await getSubscriberByCustomerId(shop, String(order.customer.id))
      : null;

    const packCount = subscriber?.pack_count || chaosItem.quantity || 3;
    const settings2 = await getSettings(shop);

    const { regular, collector } = await fetchBundleProducts(
      new shopify.clients.Graphql({ session }),
      settings2.regular_pack_ids || [],
      settings2.collector_pack_ids || []
    );

    if (!regular.length) {
      console.warn('No regular packs configured — skipping auto-generation');
      return;
    }

    const result = generateSubscriptionBundle(regular, collector, packCount, settings2, {
      enabled: true,
      lastUpgradeDate: subscriber?.last_upgrade_date || null,
    });

    if (!result) {
      console.warn('Could not generate auto bundle for', order.name);
      return;
    }

    // Update inventory for real
    await updateInventory(shopify, session, result.packs, false);

    const d20 = result.d20Result;
    const saved = await saveBundleHistory(shop, {
      subscriber_id: subscriber?.id || null,
      bundle_type: 'Chaos Club',
      customer_name: order.customer ? `${order.customer.first_name} ${order.customer.last_name}`.trim() : 'Subscriber',
      pack_count: result.packs.length,
      total_cost: result.metrics.total_cost,
      total_retail: result.metrics.total_retail,
      target_price: result.metrics.target_price,
      margin_percent: result.metrics.margin_percent,
      d20_roll: d20?.roll || null,
      d20_upgraded: d20?.upgraded || false,
      packs: result.packs,
      dry_run: false,
    });

    if (subscriber) {
      await updateSubscriber(shop, subscriber.id, {
        ...subscriber,
        months_renewed: (subscriber.months_renewed || 0) + 1,
        ...(d20?.upgraded ? {
          collector_upgrade_count: (subscriber.collector_upgrade_count || 0) + 1,
          last_upgrade_date: new Date().toISOString().slice(0, 10),
        } : {}),
      });
    }

    console.log(`✅ Auto-generated bundle #${saved.id} for Order ${order.name} (${d20?.upgraded ? '🎲 D20 upgrade!' : 'no upgrade'})`);
  } catch (err) {
    console.error('Error processing orders/paid webhook:', err.message);
  }
});

// ─── Start Server ─────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n🚀 Bundle Generator running on port ${PORT}`);
  console.log(`   NODE_ENV: ${process.env.NODE_ENV || 'development'}`);
  console.log(`   APP_URL:  ${process.env.APP_URL || 'http://localhost:' + PORT}`);
});
