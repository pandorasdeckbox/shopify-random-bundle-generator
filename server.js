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
  getBundleByShopifyOrderId,
  getProcessedChaosOrderIds,
  saveDOCXTemplate,
  getDOCXTemplate,
  deleteDOCXTemplate,
  getPotmSubscribers,
  getPotmSubscriber,
  getPotmSubscriberByCustomerId,
  createPotmSubscriber,
  updatePotmSubscriber,
  deletePotmSubscriber,
  getPotmOrderProcessing,
  savePotmOrderProcessing,
  getPotmOrderProcessingBySubscriber,
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
const POTM_UPGRADE_CUSTOM_ITEM_TITLE = 'COLLECTOR UPGRADE';

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
  scopes: ['read_products', 'write_inventory', 'read_inventory', 'read_orders', 'read_customers', 'write_order_edits'],
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
      scope: 'read_products,write_inventory,read_inventory,read_orders,read_customers,write_order_edits',
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

function toDateOnly(value) {
  if (!value) return null;
  return new Date(value).toISOString().slice(0, 10);
}

function latestDate(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return a >= b ? a : b;
}

function matchesConfiguredProduct(productId, configuredGid) {
  if (!configuredGid) return false;
  const gid = `gid://shopify/Product/${productId}`;
  return gid === configuredGid || String(productId) === String(configuredGid).split('/').pop();
}

function getExpectedPotmUpgrade(orderDates, interval) {
  const collectorUpgradeCount = Math.floor(orderDates.length / interval);
  const milestoneIndex = collectorUpgradeCount > 0 ? (collectorUpgradeCount * interval) - 1 : -1;
  return {
    collector_upgrade_count: collectorUpgradeCount,
    last_upgrade_date: milestoneIndex >= 0 ? orderDates[milestoneIndex] : null,
  };
}

async function sendDiscordWebhook(url, payload) {
  if (!url) return;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`Discord webhook failed: ${response.status} ${response.statusText}`);
  }
}

async function sendPotmUpgradeDiscordAlert(settings, subscriber, details) {
  if (!settings.potm_discord_webhook_url) return;

  const mentionLine = settings.potm_discord_webhook_mentions?.trim();
  const customerLine = subscriber.email ? `${subscriber.name} (${subscriber.email})` : subscriber.name;
  const content = [
    mentionLine || null,
    `Collector upgrade due for **${customerLine}**.`,
    `Month ${details.months} hit on ${details.renewalDate}.`,
    'Include the free collector upgrade in this shipment.',
  ].filter(Boolean).join('\n');

  await sendDiscordWebhook(settings.potm_discord_webhook_url, {
    username: 'Bundle Generator',
    content,
  });
}

function formatGraphqlUserErrors(userErrors = []) {
  return userErrors.map(error => error.message).filter(Boolean).join('; ');
}

async function beginOrderEdit(client, orderId) {
  const mutation = `
    mutation BeginOrderEdit($id: ID!) {
      orderEditBegin(id: $id) {
        calculatedOrder { id }
        userErrors { field message }
      }
    }
  `;

  const response = await client.request(mutation, {
    variables: { id: `gid://shopify/Order/${orderId}` },
  });

  const payload = response.data.orderEditBegin;
  if (payload.userErrors?.length) {
    throw new Error(formatGraphqlUserErrors(payload.userErrors));
  }

  return payload.calculatedOrder?.id || null;
}

async function addCustomItemToOrderEdit(client, calculatedOrderId, currencyCode, title) {
  const mutation = `
    mutation AddCustomItemToOrderEdit($id: ID!, $title: String!, $price: MoneyInput!, $quantity: Int!) {
      orderEditAddCustomItem(
        id: $id,
        title: $title,
        price: $price,
        quantity: $quantity,
        taxable: false,
        requiresShipping: false
      ) {
        calculatedLineItem { id title quantity }
        userErrors { field message }
      }
    }
  `;

  const response = await client.request(mutation, {
    variables: {
      id: calculatedOrderId,
      title,
      quantity: 1,
      price: { amount: '0.00', currencyCode },
    },
  });

  const payload = response.data.orderEditAddCustomItem;
  if (payload.userErrors?.length) {
    throw new Error(formatGraphqlUserErrors(payload.userErrors));
  }

  return payload.calculatedLineItem || null;
}

async function commitOrderEdit(client, calculatedOrderId, staffNote) {
  const mutation = `
    mutation CommitOrderEdit($id: ID!, $staffNote: String) {
      orderEditCommit(id: $id, notifyCustomer: false, staffNote: $staffNote) {
        order { id }
        userErrors { field message }
      }
    }
  `;

  const response = await client.request(mutation, {
    variables: { id: calculatedOrderId, staffNote },
  });

  const payload = response.data.orderEditCommit;
  if (payload.userErrors?.length) {
    throw new Error(formatGraphqlUserErrors(payload.userErrors));
  }

  return payload;
}

async function autoAddPotmUpgradeCustomItem({ session, order, subscriberName }) {
  if (!order?.id) throw new Error('Missing Shopify order ID');
  if (!order?.currency) throw new Error('Missing Shopify order currency');

  const client = new shopify.clients.Graphql({ session });
  const calculatedOrderId = await beginOrderEdit(client, order.id);
  if (!calculatedOrderId) throw new Error('Shopify did not return a calculated order ID');

  await addCustomItemToOrderEdit(client, calculatedOrderId, order.currency, POTM_UPGRADE_CUSTOM_ITEM_TITLE);

  return commitOrderEdit(
    client,
    calculatedOrderId,
    `Auto-added ${POTM_UPGRADE_CUSTOM_ITEM_TITLE} for POTM milestone on ${order.name || `order ${order.id}`} for ${subscriberName || 'subscriber'}`
  );
}

async function buildPotmOrderSummary(session, configuredProductId) {
  const client = new shopify.clients.Rest({ session });
  const orderMap = new Map();

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
        fields: 'id,name,created_at,processed_at,cancelled_at,financial_status,customer,line_items',
      },
    });

    const orders = response.body.orders || [];

    for (const order of orders) {
      if (!order.customer || order.cancelled_at) continue;
      if (order.financial_status && order.financial_status !== 'paid') continue;

      const lineItem = (order.line_items || []).find(item => matchesConfiguredProduct(item.product_id, configuredProductId));
      if (!lineItem) continue;

      const customerId = String(order.customer.id);
      const orderDate = toDateOnly(order.processed_at || order.created_at);

      if (!orderMap.has(customerId)) {
        orderMap.set(customerId, {
          shopify_customer_id: customerId,
          name: `${order.customer.first_name || ''} ${order.customer.last_name || ''}`.trim() || `Customer ${customerId}`,
          email: order.customer.email || null,
          first_order_date: orderDate,
          last_order_date: orderDate,
          months_renewed: 1,
          order_dates: [orderDate],
        });
      } else {
        const existing = orderMap.get(customerId);
        existing.months_renewed += 1;
        existing.order_dates.push(orderDate);
        if (orderDate < existing.first_order_date) existing.first_order_date = orderDate;
        if (orderDate > existing.last_order_date) existing.last_order_date = orderDate;
      }
    }

    if (orders.length === 250) {
      sinceId = orders[orders.length - 1].id;
    } else {
      hasMore = false;
    }
  }

  for (const summary of orderMap.values()) {
    summary.order_dates.sort();
  }

  return orderMap;
}

async function findLatestPotmPaidOrderForCustomer(session, configuredProductId, shopifyCustomerId) {
  const client = new shopify.clients.Rest({ session });
  const response = await client.get({
    path: 'orders',
    query: {
      limit: 250,
      status: 'any',
      customer_id: shopifyCustomerId,
      fields: 'id,name,currency,created_at,processed_at,cancelled_at,financial_status,line_items',
    },
  });

  const orders = response.body.orders || [];
  const matchingOrders = orders.filter(order => {
    if (order.cancelled_at) return false;
    if (order.financial_status && order.financial_status !== 'paid') return false;
    return (order.line_items || []).some(item => matchesConfiguredProduct(item.product_id, configuredProductId));
  });

  matchingOrders.sort((a, b) => {
    const aDate = new Date(a.processed_at || a.created_at || 0).getTime();
    const bDate = new Date(b.processed_at || b.created_at || 0).getTime();
    return bDate - aDate;
  });

  return matchingOrders[0] || null;
}

function getChaosPackCount(chaosItem, subscriber) {
  const variantTitle = chaosItem?.variant_title || '';
  const variantNum = parseInt(variantTitle.match(/\b(3|6|9|12)\b/)?.[1] || '0', 10);
  return ([3, 6, 9, 12].includes(variantNum) ? variantNum : null)
    || subscriber?.pack_count
    || 3;
}

async function buildPendingChaosClubOrders(session, configuredProductId, processedOrderIds = new Set()) {
  if (!configuredProductId) return [];

  const client = new shopify.clients.Rest({ session });
  const pendingOrders = [];

  let sinceId = 0;
  let hasMore = true;

  while (hasMore) {
    const response = await client.get({
      path: 'orders',
      query: {
        limit: 250,
        status: 'any',
        fulfillment_status: 'unfulfilled',
        financial_status: 'paid',
        created_at_min: '2018-01-01T00:00:00Z',
        since_id: sinceId,
        fields: 'id,name,created_at,processed_at,cancelled_at,financial_status,fulfillment_status,customer,line_items',
      },
    });

    const orders = response.body.orders || [];

    for (const order of orders) {
      const orderId = String(order.id);
      if (processedOrderIds.has(orderId)) continue;
      if (order.cancelled_at) continue;
      if (order.financial_status && order.financial_status !== 'paid') continue;

      const chaosItem = (order.line_items || []).find(item => matchesConfiguredProduct(item.product_id, configuredProductId));
      if (!chaosItem) continue;

      const customerName = order.customer
        ? `${order.customer.first_name || ''} ${order.customer.last_name || ''}`.trim() || `Customer ${order.customer.id}`
        : 'Unknown customer';

      pendingOrders.push({
        id: orderId,
        name: order.name || `Order ${orderId}`,
        created_at: order.created_at || null,
        processed_at: order.processed_at || null,
        financial_status: order.financial_status || null,
        fulfillment_status: order.fulfillment_status || null,
        customer_name: customerName,
        customer_email: order.customer?.email || null,
        shopify_customer_id: order.customer?.id ? String(order.customer.id) : null,
        pack_count: getChaosPackCount(chaosItem, null),
      });
    }

    if (orders.length === 250) {
      sinceId = orders[orders.length - 1].id;
    } else {
      hasMore = false;
    }
  }

  pendingOrders.sort((a, b) => {
    const aTime = new Date(a.processed_at || a.created_at || 0).getTime();
    const bTime = new Date(b.processed_at || b.created_at || 0).getTime();
    return aTime - bTime;
  });

  return pendingOrders;
}

async function processChaosClubOrder({ shop, session, settings, order, dryRun = false }) {
  if (!order?.id) throw new Error('Missing Shopify order ID');

  const shopifyOrderId = String(order.id);
  const existingBundle = !dryRun ? await getBundleByShopifyOrderId(shop, shopifyOrderId) : null;
  if (existingBundle) {
    return {
      alreadyProcessed: true,
      history: existingBundle,
      orderName: order.name || existingBundle.shopify_order_name || `Order ${shopifyOrderId}`,
    };
  }

  const lineItems = order.line_items || [];
  const chaosItem = lineItems.find(item => matchesConfiguredProduct(item.product_id, settings.chaos_club_product_id));
  if (!chaosItem) {
    throw new Error('Order does not contain the configured Chaos Club product.');
  }

  const subscriber = order.customer?.id
    ? await getSubscriberByCustomerId(shop, String(order.customer.id))
    : null;

  const packCount = getChaosPackCount(chaosItem, subscriber);
  const { regular, collector } = await fetchBundleProducts(
    new shopify.clients.Graphql({ session }),
    settings.regular_pack_ids || [],
    settings.collector_pack_ids || []
  );

  if (!regular.length) {
    throw new Error('No regular packs configured. Go to Products tab and select eligible packs.');
  }

  const result = generateSubscriptionBundle(regular, collector, packCount, settings, {
    enabled: true,
    lastUpgradeDate: subscriber?.last_upgrade_date || null,
  });

  if (!result) {
    throw new Error('Could not generate a Chaos Club bundle meeting margin requirements.');
  }

  const inventoryResults = await updateInventory(shopify, session, result.packs, dryRun);
  const customerName = order.customer
    ? `${order.customer.first_name || ''} ${order.customer.last_name || ''}`.trim() || 'Subscriber'
    : 'Subscriber';
  const d20 = result.d20Result;

  const saved = await saveBundleHistory(shop, {
    subscriber_id: subscriber?.id || null,
    shopify_order_id: shopifyOrderId,
    shopify_order_name: order.name || null,
    bundle_type: 'Chaos Club',
    customer_name: customerName,
    pack_count: result.packs.length,
    total_cost: result.metrics.total_cost,
    total_retail: result.metrics.total_retail,
    target_price: result.metrics.target_price,
    margin_percent: result.metrics.margin_percent,
    d20_roll: d20?.roll || null,
    d20_upgraded: d20?.upgraded || false,
    packs: result.packs,
    dry_run: dryRun,
  });

  if (subscriber && !dryRun) {
    await updateSubscriber(shop, subscriber.id, {
      ...subscriber,
      months_renewed: (subscriber.months_renewed || 0) + 1,
      ...(d20?.upgraded ? {
        collector_upgrade_count: (subscriber.collector_upgrade_count || 0) + 1,
        last_upgrade_date: new Date().toISOString().slice(0, 10),
      } : {}),
    });
  }

  return {
    alreadyProcessed: false,
    history: saved,
    result,
    inventoryResults,
    subscriber,
    orderName: order.name || `Order ${shopifyOrderId}`,
    packCount,
  };
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

app.post('/api/potm/test-discord-webhook', verifySession, async (req, res) => {
  try {
    const webhookUrl = req.body.webhookUrl?.trim();
    const mentions = req.body.mentions?.trim();

    if (!webhookUrl) {
      return res.status(400).json({ error: 'Enter a POTM Discord webhook URL first.' });
    }

    const content = [
      mentions || null,
      'POTM Discord webhook test from Bundle Generator.',
      `Shop: ${req.shopifySession.shop}`,
      `Sent: ${new Date().toISOString()}`,
    ].filter(Boolean).join('\n');

    await sendDiscordWebhook(webhookUrl, {
      username: 'Bundle Generator',
      content,
    });

    res.json({ success: true, message: 'Test message sent to Discord.' });
  } catch (err) {
    console.error('Error testing POTM Discord webhook:', err.message);
    res.status(500).json({ error: err.message || 'Failed to send test Discord webhook' });
  }
});

// ─── API: Generate Bundle ─────────────────────────────────────────────────────

app.get('/api/chaos/pending-orders', verifySession, async (req, res) => {
  try {
    const shop = req.shopifySession.shop;
    const settings = await getSettings(shop);

    if (!settings.chaos_club_product_id) {
      return res.json({ orders: [] });
    }

    const processedOrderIds = new Set(await getProcessedChaosOrderIds(shop));
    const orders = await buildPendingChaosClubOrders(req.shopifySession, settings.chaos_club_product_id, processedOrderIds);
    res.json({ orders });
  } catch (err) {
    console.error('Error fetching pending Chaos Club orders:', err.message);
    res.status(500).json({ error: 'Failed to fetch pending Chaos Club orders' });
  }
});

app.post('/api/chaos/pending-orders/process-next', verifySession, async (req, res) => {
  try {
    const shop = req.shopifySession.shop;
    const settings = await getSettings(shop);

    if (!settings.chaos_club_product_id) {
      return res.status(400).json({ error: 'Set the Chaos Club product ID in Settings first.' });
    }

    const processedOrderIds = new Set(await getProcessedChaosOrderIds(shop));
    const [nextPendingOrder] = await buildPendingChaosClubOrders(req.shopifySession, settings.chaos_club_product_id, processedOrderIds);
    if (!nextPendingOrder) {
      return res.status(404).json({ error: 'No pending Chaos Club orders found.' });
    }

    const client = new shopify.clients.Rest({ session: req.shopifySession });
    const response = await client.get({
      path: `orders/${nextPendingOrder.id}`,
      query: {
        fields: 'id,name,created_at,processed_at,cancelled_at,financial_status,customer,line_items',
      },
    });

    const order = response.body.order;
    const processed = await processChaosClubOrder({
      shop,
      session: req.shopifySession,
      settings,
      order,
      dryRun: false,
    });

    res.json({
      success: true,
      alreadyProcessed: processed.alreadyProcessed,
      order: nextPendingOrder,
      bundle: processed.history,
      message: processed.alreadyProcessed
        ? `${nextPendingOrder.name} was already processed.`
        : `${nextPendingOrder.name} processed successfully.`,
    });
  } catch (err) {
    console.error('Error processing next pending Chaos Club order:', err.message);
    res.status(500).json({ error: 'Failed to process next pending Chaos Club order: ' + err.message });
  }
});

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
    if (subscriber_id && d20Result?.upgraded && !dry_run) {
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

// ─── API: POTM Subscribers ────────────────────────────────────────────────────

app.get('/api/potm/subscribers', verifySession, async (req, res) => {
  try {
    const shop = req.shopifySession.shop;
    const [subs, processingRows] = await Promise.all([
      getPotmSubscribers(shop),
      getPotmOrderProcessingBySubscriber(shop),
    ]);

    const processingBySubscriberId = new Map();
    for (const row of processingRows) {
      if (!processingBySubscriberId.has(row.potm_subscriber_id)) {
        processingBySubscriberId.set(row.potm_subscriber_id, []);
      }
      processingBySubscriberId.get(row.potm_subscriber_id).push(row);
    }

    const enrichedSubscribers = subs.map(sub => ({
      ...sub,
      latest_order_processing: processingBySubscriberId.get(sub.id)?.[0] || null,
      current_milestone_processing: (processingBySubscriberId.get(sub.id) || []).find(row =>
        Number(row.months_after || 0) === Number(sub.months_renewed || 0) && Boolean(row.upgrade_due)
      ) || null,
    }));

    res.json({ subscribers: enrichedSubscribers });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch POTM subscribers' });
  }
});

app.post('/api/potm/subscribers', verifySession, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    const sub = await createPotmSubscriber(req.shopifySession.shop, req.body);
    res.json({ subscriber: sub });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create POTM subscriber: ' + err.message });
  }
});

app.put('/api/potm/subscribers/:id', verifySession, async (req, res) => {
  try {
    const sub = await updatePotmSubscriber(req.shopifySession.shop, req.params.id, req.body);
    if (!sub) return res.status(404).json({ error: 'POTM subscriber not found' });
    res.json({ subscriber: sub });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update POTM subscriber: ' + err.message });
  }
});

app.delete('/api/potm/subscribers/:id', verifySession, async (req, res) => {
  try {
    await deletePotmSubscriber(req.shopifySession.shop, req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete POTM subscriber: ' + err.message });
  }
});

// ─── API: POTM Import Preview ─────────────────────────────────────────────────

app.get('/api/potm/subscribers/import-preview', verifySession, async (req, res) => {
  try {
    const shop = req.shopifySession.shop;
    const settings = await getSettings(shop);
    const potmProductId = req.query.product_gid || settings.potm_product_id;
    if (!potmProductId) return res.status(400).json({ error: 'No POTM product selected.' });

    const orderMap = await buildPotmOrderSummary(req.shopifySession, potmProductId);

    const existingSubs = await getPotmSubscribers(shop);
    const existingIds = new Set(existingSubs.map(s => String(s.shopify_customer_id)).filter(Boolean));

    const candidates = Array.from(orderMap.values())
      .map(c => ({ ...c, already_exists: existingIds.has(c.shopify_customer_id) }))
      .sort((a, b) => { if (a.already_exists !== b.already_exists) return a.already_exists ? 1 : -1; return a.name.localeCompare(b.name); });

    res.json({ candidates });
  } catch (err) {
    console.error('POTM import preview error:', err.message);
    res.status(500).json({ error: 'Failed to fetch order history: ' + err.message });
  }
});

// ─── API: POTM Import Confirm ─────────────────────────────────────────────────

app.post('/api/potm/subscribers/import', verifySession, async (req, res) => {
  try {
    const shop = req.shopifySession.shop;
    const { candidates } = req.body;
    if (!Array.isArray(candidates) || !candidates.length || candidates.length > 500) {
      return res.status(400).json({ error: 'No candidates provided' });
    }

    const existingSubs = await getPotmSubscribers(shop);
    const existingIds = new Set(existingSubs.map(s => String(s.shopify_customer_id)).filter(Boolean));

    let imported = 0, skipped = 0;
    for (const c of candidates) {
      if (existingIds.has(String(c.shopify_customer_id))) { skipped++; continue; }
      await createPotmSubscriber(shop, {
        name: c.name,
        email: c.email || null,
        shopify_customer_id: c.shopify_customer_id,
        start_date: c.first_order_date ? c.first_order_date.slice(0, 10) : null,
        months_renewed: c.months_renewed || 0,
        collector_upgrade_count: 0,
        last_renewal_date: c.last_order_date || null,
        last_upgrade_date: null,
        status: 'active',
      });
      imported++;
    }

    res.json({ imported, skipped });
  } catch (err) {
    console.error('POTM import error:', err.message);
    res.status(500).json({ error: 'Import failed: ' + err.message });
  }
});

// ─── API: POTM Record Renewal ─────────────────────────────────────────────────

app.post('/api/potm/subscribers/:id/renew', verifySession, async (req, res) => {
  try {
    const shop = req.shopifySession.shop;
    const settings = await getSettings(shop);
    const interval = settings.potm_upgrade_interval_months || 6;

    const sub = await getPotmSubscriber(shop, req.params.id);
    if (!sub) return res.status(404).json({ error: 'Subscriber not found' });

    const newMonths = (sub.months_renewed || 0) + 1;
    const upgraded = newMonths % interval === 0;

    const updated = await updatePotmSubscriber(shop, sub.id, {
      ...sub,
      months_renewed: newMonths,
      last_renewal_date: toDateOnly(new Date()),
      ...(upgraded ? {
        collector_upgrade_count: (sub.collector_upgrade_count || 0) + 1,
        last_upgrade_date: new Date().toISOString().slice(0, 10),
      } : {}),
    });

    if (!updated) {
      log('ERROR', `POTM renewal failed — update returned null`, { id: sub.id, name: sub.name });
      return res.status(500).json({ error: 'Database update failed — subscriber not found or not updated' });
    }

    if (upgraded) {
      try {
        await sendPotmUpgradeDiscordAlert(settings, updated, {
          months: updated.months_renewed,
          renewalDate: updated.last_renewal_date,
        });
      } catch (notifyErr) {
        log('WARN', 'Failed to send POTM Discord alert', { error: notifyErr.message, subscriber_id: updated.id });
      }
    }

    log('INFO', `POTM renewal recorded for ${sub.name}`, { months: updated.months_renewed, upgraded });
    res.json({ subscriber: updated, upgraded, months: updated.months_renewed });
  } catch (err) {
    console.error('POTM renew error:', err.message);
    res.status(500).json({ error: 'Failed to record renewal: ' + err.message });
  }
});

app.post('/api/potm/subscribers/:id/add-upgrade-to-latest-order', verifySession, async (req, res) => {
  try {
    const shop = req.shopifySession.shop;
    const settings = await getSettings(shop);
    const interval = settings.potm_upgrade_interval_months || 6;

    if (!settings.potm_product_id) {
      return res.status(400).json({ error: 'Set the Pack of the Month product ID in Settings first.' });
    }

    const subscriber = await getPotmSubscriber(shop, req.params.id);
    if (!subscriber) return res.status(404).json({ error: 'Subscriber not found' });
    if (!subscriber.shopify_customer_id) {
      return res.status(400).json({ error: 'Subscriber is missing a Shopify customer ID.' });
    }

    const months = subscriber.months_renewed || 0;
    const upgradeDue = months > 0 && months % interval === 0;
    if (!upgradeDue) {
      return res.status(400).json({ error: 'Subscriber is not currently due for a collector upgrade.' });
    }

    const session = await sessionStorage.loadSession(`offline_${shop}`);
    if (!session) {
      return res.status(401).json({ error: 'No Shopify session found. Reauthorize the app and try again.' });
    }

    const order = await findLatestPotmPaidOrderForCustomer(session, settings.potm_product_id, subscriber.shopify_customer_id);
    if (!order) {
      return res.status(404).json({ error: 'No paid Pack of the Month Shopify order was found for this subscriber.' });
    }

    const shopifyOrderId = String(order.id);
    let processing = await getPotmOrderProcessing(shop, shopifyOrderId) || null;
    const saveProcessing = async (updates = {}) => {
      processing = await savePotmOrderProcessing(shop, shopifyOrderId, {
        shopify_order_name: order.name || processing?.shopify_order_name || null,
        potm_subscriber_id: updates.potm_subscriber_id ?? processing?.potm_subscriber_id ?? subscriber.id,
        renewal_processed: updates.renewal_processed ?? processing?.renewal_processed ?? false,
        renewal_date: updates.renewal_date ?? processing?.renewal_date ?? null,
        months_after: updates.months_after ?? processing?.months_after ?? months,
        upgrade_due: updates.upgrade_due ?? processing?.upgrade_due ?? upgradeDue,
        discord_alert_sent: updates.discord_alert_sent ?? processing?.discord_alert_sent ?? false,
        upgrade_line_item_added: updates.upgrade_line_item_added ?? processing?.upgrade_line_item_added ?? false,
        order_edit_message: updates.order_edit_message ?? processing?.order_edit_message ?? null,
      });
      return processing;
    };

    if (Boolean(processing?.upgrade_line_item_added)) {
      return res.json({
        success: true,
        orderName: order.name,
        alreadyAdded: true,
        processing,
        message: processing.order_edit_message || `${POTM_UPGRADE_CUSTOM_ITEM_TITLE} was already added to the latest Shopify order.`,
      });
    }

    if ((order.line_items || []).some(item => item.title === POTM_UPGRADE_CUSTOM_ITEM_TITLE)) {
      await saveProcessing({
        upgrade_line_item_added: true,
        order_edit_message: `${POTM_UPGRADE_CUSTOM_ITEM_TITLE} already present on order payload.`,
      });
      return res.json({
        success: true,
        orderName: order.name,
        alreadyAdded: true,
        processing,
        message: `${POTM_UPGRADE_CUSTOM_ITEM_TITLE} was already present on ${order.name}.`,
      });
    }

    await autoAddPotmUpgradeCustomItem({
      session,
      order,
      subscriberName: subscriber.name,
    });

    const message = `${POTM_UPGRADE_CUSTOM_ITEM_TITLE} added automatically.`;
    await saveProcessing({
      upgrade_line_item_added: true,
      order_edit_message: message,
      months_after: months,
      upgrade_due: upgradeDue,
    });

    res.json({
      success: true,
      orderName: order.name,
      alreadyAdded: false,
      processing,
      message,
    });
  } catch (err) {
    console.error('POTM manual upgrade order edit error:', err.message);
    res.status(500).json({ error: 'Failed to add collector upgrade to latest Shopify order: ' + err.message });
  }
});

app.post('/api/potm/subscribers/reconcile', verifySession, async (req, res) => {
  try {
    const shop = req.shopifySession.shop;
    const settings = await getSettings(shop);
    const interval = settings.potm_upgrade_interval_months || 6;

    if (!settings.potm_product_id) {
      return res.status(400).json({ error: 'Set the Pack of the Month product ID in Settings first.' });
    }

    const orderMap = await buildPotmOrderSummary(req.shopifySession, settings.potm_product_id);
    const existingSubs = await getPotmSubscribers(shop);
    const updatedSubscribers = [];
    const unmatchedSubscribers = [];

    for (const sub of existingSubs) {
      if (!sub.shopify_customer_id || sub.status !== 'active') continue;

      const orderSummary = orderMap.get(String(sub.shopify_customer_id));
      if (!orderSummary) {
        unmatchedSubscribers.push({
          id: sub.id,
          name: sub.name,
          months_renewed: sub.months_renewed || 0,
          last_renewal_date: sub.last_renewal_date || null,
        });
        continue;
      }

      const expectedUpgrade = getExpectedPotmUpgrade(orderSummary.order_dates, interval);
      const reconciledMonths = Math.max(sub.months_renewed || 0, orderSummary.months_renewed || 0);
      const reconciledUpgradeCount = Math.max(sub.collector_upgrade_count || 0, expectedUpgrade.collector_upgrade_count || 0);
      const reconciledLastUpgrade = latestDate(sub.last_upgrade_date || null, expectedUpgrade.last_upgrade_date || null);
      const earliestStartDate = sub.start_date && orderSummary.first_order_date
        ? (sub.start_date <= orderSummary.first_order_date ? sub.start_date : orderSummary.first_order_date)
        : (sub.start_date || orderSummary.first_order_date || null);
      const nextLastRenewal = orderSummary.last_order_date || sub.last_renewal_date || null;

      const shouldUpdate =
        reconciledMonths !== (sub.months_renewed || 0)
        || reconciledUpgradeCount !== (sub.collector_upgrade_count || 0)
        || nextLastRenewal !== (sub.last_renewal_date || null)
        || reconciledLastUpgrade !== (sub.last_upgrade_date || null)
        || earliestStartDate !== (sub.start_date || null)
        || (!sub.email && orderSummary.email);

      if (!shouldUpdate) continue;

      const updated = await updatePotmSubscriber(shop, sub.id, {
        ...sub,
        email: sub.email || orderSummary.email || null,
        start_date: earliestStartDate,
        months_renewed: reconciledMonths,
        collector_upgrade_count: reconciledUpgradeCount,
        last_renewal_date: nextLastRenewal,
        last_upgrade_date: reconciledLastUpgrade,
      });

      updatedSubscribers.push({
        id: updated.id,
        name: updated.name,
        previous_months: sub.months_renewed || 0,
        months_renewed: updated.months_renewed || 0,
        months_added: (updated.months_renewed || 0) - (sub.months_renewed || 0),
        previous_last_renewal_date: sub.last_renewal_date || null,
        last_renewal_date: updated.last_renewal_date || null,
        missed_upgrades: Math.max(0, (updated.collector_upgrade_count || 0) - (sub.collector_upgrade_count || 0)),
      });
    }

    res.json({
      updated_count: updatedSubscribers.length,
      unmatched_count: unmatchedSubscribers.length,
      updated_subscribers: updatedSubscribers,
      unmatched_subscribers: unmatchedSubscribers,
    });
  } catch (err) {
    console.error('POTM reconcile error:', err.message);
    res.status(500).json({ error: 'Failed to reconcile POTM subscribers: ' + err.message });
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
    const lineItems = order.line_items || [];

    // ── Chaos Club branch ──────────────────────────────────────────────────
    const chaosItem = lineItems.find(item => matchesConfiguredProduct(item.product_id, settings.chaos_club_product_id));
    if (chaosItem) {
      console.log(`🎲 Chaos Club renewal detected for customer ${order.customer?.id}`);

      const session = await sessionStorage.loadSession(`offline_${shop}`);
      if (!session) { console.error('No session found for shop', shop); return; }

      const processed = await processChaosClubOrder({
        shop,
        session,
        settings,
        order,
        dryRun: false,
      });

      if (processed.alreadyProcessed) {
        console.log(`ℹ️ Chaos Club order ${order.name} already processed as bundle #${processed.history.id}`);
      } else {
        console.log(`✅ Auto-generated bundle #${processed.history.id} for Order ${order.name} (${processed.result.d20Result?.upgraded ? '🎲 D20 upgrade!' : 'no upgrade'})`);
      }
    }

    // ── Pack of the Month branch ───────────────────────────────────────────
    const potmItem = lineItems.find(item => matchesConfiguredProduct(item.product_id, settings.potm_product_id));
    if (potmItem) {
      console.log(`🎴 Pack of the Month renewal detected for customer ${order.customer?.id}`);

      const shopifyOrderId = String(order.id);
      const upgradeInterval = settings.potm_upgrade_interval_months || 6;
      const renewalDate = toDateOnly(order.processed_at || order.created_at || new Date());
      let subscriber = order.customer?.id
        ? await getPotmSubscriberByCustomerId(shop, String(order.customer.id))
        : null;

      let processing = await getPotmOrderProcessing(shop, shopifyOrderId) || null;
      const saveProcessing = async (updates = {}) => {
        processing = await savePotmOrderProcessing(shop, shopifyOrderId, {
          shopify_order_name: order.name || processing?.shopify_order_name || null,
          potm_subscriber_id: updates.potm_subscriber_id ?? processing?.potm_subscriber_id ?? subscriber?.id ?? null,
          renewal_processed: updates.renewal_processed ?? processing?.renewal_processed ?? false,
          renewal_date: updates.renewal_date ?? processing?.renewal_date ?? null,
          months_after: updates.months_after ?? processing?.months_after ?? null,
          upgrade_due: updates.upgrade_due ?? processing?.upgrade_due ?? false,
          discord_alert_sent: updates.discord_alert_sent ?? processing?.discord_alert_sent ?? false,
          upgrade_line_item_added: updates.upgrade_line_item_added ?? processing?.upgrade_line_item_added ?? false,
          order_edit_message: updates.order_edit_message ?? processing?.order_edit_message ?? null,
        });
        return processing;
      };

      let monthsAfter = Number(processing?.months_after || 0);
      let hitUpgrade = Boolean(processing?.upgrade_due);

      if (!Boolean(processing?.renewal_processed)) {
        const newMonths = (subscriber?.months_renewed || 0) + 1;
        hitUpgrade = newMonths > 0 && newMonths % upgradeInterval === 0;

        if (subscriber) {
          subscriber = await updatePotmSubscriber(shop, subscriber.id, {
            ...subscriber,
            months_renewed: newMonths,
            last_renewal_date: renewalDate,
            ...(hitUpgrade ? {
              collector_upgrade_count: (subscriber.collector_upgrade_count || 0) + 1,
              last_upgrade_date: renewalDate,
            } : {}),
          });
          monthsAfter = subscriber.months_renewed || newMonths;
          console.log(`✅ POTM subscriber updated: ${subscriber.name} — ${monthsAfter} months${hitUpgrade ? ' 🌟 Collector upgrade triggered!' : ''}`);
        } else {
          subscriber = await createPotmSubscriber(shop, {
            shopify_customer_id: order.customer ? String(order.customer.id) : null,
            name: order.customer ? `${order.customer.first_name} ${order.customer.last_name}`.trim() : 'Subscriber',
            email: order.customer?.email || null,
            start_date: renewalDate,
            months_renewed: 1,
            collector_upgrade_count: 0,
            last_renewal_date: renewalDate,
            ...(hitUpgrade ? { collector_upgrade_count: 1, last_upgrade_date: renewalDate } : {}),
            status: 'active',
          });
          monthsAfter = subscriber.months_renewed || 1;
          console.log(`✅ POTM new subscriber auto-created: ${subscriber.name}`);
        }

        await saveProcessing({
          potm_subscriber_id: subscriber?.id || null,
          renewal_processed: true,
          renewal_date: renewalDate,
          months_after: monthsAfter,
          upgrade_due: hitUpgrade,
        });
      } else {
        log('INFO', 'POTM renewal already processed for this Shopify order', { shop, shopify_order_id: shopifyOrderId });
        if (!subscriber && processing?.potm_subscriber_id) {
          subscriber = await getPotmSubscriber(shop, processing.potm_subscriber_id);
        }
      }

      if (hitUpgrade && subscriber && !Boolean(processing?.discord_alert_sent)) {
        try {
          await sendPotmUpgradeDiscordAlert(settings, subscriber, { months: monthsAfter, renewalDate });
          await saveProcessing({ discord_alert_sent: true });
        } catch (notifyErr) {
          log('WARN', 'Failed to send POTM Discord alert', { error: notifyErr.message, shop, customer_id: order.customer?.id });
        }
      }

      if (hitUpgrade && !Boolean(processing?.upgrade_line_item_added)) {
        if (lineItems.some(item => item.title === POTM_UPGRADE_CUSTOM_ITEM_TITLE)) {
          await saveProcessing({
            upgrade_line_item_added: true,
            order_edit_message: `${POTM_UPGRADE_CUSTOM_ITEM_TITLE} already present on order payload.`,
          });
        } else {
          const session = await sessionStorage.loadSession(`offline_${shop}`);
          if (!session) {
            log('WARN', 'No session found for POTM order edit', { shop, shopify_order_id: shopifyOrderId });
            await saveProcessing({ order_edit_message: 'No offline Shopify session available for order edit.' });
          } else {
            try {
              await autoAddPotmUpgradeCustomItem({
                session,
                order,
                subscriberName: subscriber?.name,
              });

              await saveProcessing({
                upgrade_line_item_added: true,
                order_edit_message: `${POTM_UPGRADE_CUSTOM_ITEM_TITLE} added automatically.`,
              });
              log('SUCCESS', 'POTM collector upgrade custom item added to Shopify order', { shop, shopify_order_id: shopifyOrderId });
            } catch (editErr) {
              await saveProcessing({ order_edit_message: `Auto-add failed: ${editErr.message}` });
              log('WARN', 'Failed to auto-add POTM collector upgrade custom item', { error: editErr.message, shop, shopify_order_id: shopifyOrderId });
            }
          }
        }
      }
    }

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
