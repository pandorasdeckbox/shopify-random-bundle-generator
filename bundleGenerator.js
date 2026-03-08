/**
 * Bundle Generator - ports the Python chaos_club_generator.py logic to JavaScript
 *
 * Uses Shopify GraphQL API to fetch product data with costs in one efficient query,
 * then runs the same randomized bundle selection and scoring algorithms.
 */

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Fisher-Yates sample: pick n random items from arr without replacement */
function randomSample(arr, n) {
  if (n >= arr.length) return [...arr];
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, n);
}

/** Calculate complete months between a past date string (YYYY-MM-DD or M/D/YYYY) and today */
export function calculateMonthsSince(dateStr) {
  if (!dateStr) return 0;
  let d;
  if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(dateStr)) {
    const [m, day, y] = dateStr.split('/');
    d = new Date(parseInt(y), parseInt(m) - 1, parseInt(day));
  } else {
    d = new Date(dateStr);
  }
  if (isNaN(d.getTime())) return 0;
  const now = new Date();
  return (now.getFullYear() - d.getFullYear()) * 12 + (now.getMonth() - d.getMonth());
}

/** Extract numeric ID from Shopify GID (e.g. "gid://shopify/InventoryItem/12345" → "12345") */
export function gidToNumeric(gid) {
  return String(gid).split('/').pop();
}

// ─── Product Fetching ─────────────────────────────────────────────────────────

/**
 * Fetch all products for the configuration UI (paginated, no cost data needed)
 */
export async function fetchAllProducts(client) {
  const query = `
    query GetProducts($cursor: String) {
      products(first: 50, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          title
          status
          productType
          tags
          totalInventory
          priceRangeV2 {
            minVariantPrice { amount }
          }
        }
      }
    }
  `;

  const allProducts = [];
  let cursor = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const response = await client.request(query, { variables: { cursor } });
    const { nodes, pageInfo } = response.data.products;
    allProducts.push(...nodes);
    hasNextPage = pageInfo.hasNextPage;
    cursor = pageInfo.endCursor;
  }

  return allProducts;
}

/**
 * Fetch all Shopify collections with the IDs of their member products.
 * Used by the Products tab to enable bulk-selection by collection.
 */
export async function fetchCollections(client) {
  const query = `
    query GetCollections($cursor: String) {
      collections(first: 50, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          title
          products(first: 250) {
            nodes { id }
          }
        }
      }
    }
  `;

  const allCollections = [];
  let cursor = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const response = await client.request(query, { variables: { cursor } });
    const { nodes, pageInfo } = response.data.collections;
    for (const col of nodes) {
      allCollections.push({
        id: col.id,
        title: col.title,
        productIds: col.products.nodes.map(p => p.id),
      });
    }
    hasNextPage = pageInfo.hasNextPage;
    cursor = pageInfo.endCursor;
  }

  return allCollections;
}

/**
 * Fetch selected products (by GID) WITH cost data — used at bundle generation time.
 * Uses the efficient GraphQL nodes() query to get all data in one request.
 */
export async function fetchBundleProducts(client, regularIds, collectorIds) {
  const allIds = [...new Set([...regularIds, ...collectorIds])];
  if (!allIds.length) return { regular: [], collector: [] };

  const query = `
    query GetNodes($ids: [ID!]!) {
      nodes(ids: $ids) {
        ... on Product {
          id
          title
          status
          productType
          variants(first: 10) {
            nodes {
              id
              title
              price
              inventoryQuantity
              inventoryItem {
                id
                unitCost { amount }
              }
            }
          }
        }
      }
    }
  `;

  const response = await client.request(query, { variables: { ids: allIds } });
  const nodes = response.data.nodes.filter(Boolean);

  const regular = [];
  const collector = [];

  for (const product of nodes) {
    if (!product || product.status !== 'ACTIVE') continue;

    const isCollector = collectorIds.includes(product.id);
    const isRegular = regularIds.includes(product.id);

    for (const v of product.variants.nodes) {
      const cost = v.inventoryItem?.unitCost?.amount;
      if (cost === null || cost === undefined || cost === '') continue;

      const pack = {
        id: v.id,
        product_id: product.id,
        product_title: product.title,
        variant_title: v.title === 'Default Title' ? '' : v.title,
        price: parseFloat(v.price),
        cost: parseFloat(cost),
        inventory_quantity: v.inventoryQuantity,
        inventory_item_id: v.inventoryItem.id,
        is_collector: isCollector,
      };

      if (pack.price <= 0 || isNaN(pack.cost)) continue;

      if (isCollector) collector.push(pack);
      else if (isRegular) regular.push(pack);
    }
  }

  return { regular, collector };
}

// ─── D20 Upgrade System ───────────────────────────────────────────────────────

/**
 * Roll a D20 and optionally upgrade one pack to a collector pack.
 * Mirrors the Python roll_d20_upgrade() function.
 */
export function rollD20Upgrade(selectedPacks, collectorPacks, settings, lastUpgradeDate) {
  const maxPrice = settings.collector_upgrade_max_price || 50;
  const luckMonths = settings.luck_protection_months || 12;

  const affordable = collectorPacks.filter(p => p.inventory_quantity > 0 && p.price <= maxPrice);
  if (!affordable.length) {
    return { packs: selectedPacks, roll: 0, upgraded: false, reason: 'No affordable collector packs available' };
  }

  const monthsSince = calculateMonthsSince(lastUpgradeDate);
  const roll = Math.floor(Math.random() * 20) + 1;
  const luckProtection = lastUpgradeDate && monthsSince >= luckMonths;

  let upgraded = false;
  let reason = '';

  if (roll === 20) {
    upgraded = true;
    reason = `Natural 20! 🎉`;
  } else if (luckProtection) {
    upgraded = true;
    reason = `Luck protection (${monthsSince} months since last upgrade)`;
  } else {
    reason = `Rolled ${roll}${lastUpgradeDate ? ` (${luckMonths - monthsSince} months until luck protection)` : ''}`;
  }

  if (!upgraded) return { packs: selectedPacks, roll, upgraded: false, reason };

  const chosen = affordable[Math.floor(Math.random() * affordable.length)];
  const replaceIdx = Math.floor(Math.random() * selectedPacks.length);
  const upgradedPacks = [...selectedPacks];
  const replacedPack = upgradedPacks[replaceIdx];
  upgradedPacks[replaceIdx] = { ...chosen, is_collector: true };

  return {
    packs: upgradedPacks,
    roll,
    upgraded: true,
    reason,
    upgradedFrom: replacedPack.product_title,
    upgradedTo: chosen.product_title,
  };
}

// ─── Bundle Scoring ───────────────────────────────────────────────────────────

function scoreBundle(marginPercent, minMargin, idealMargin, packs) {
  let score = marginPercent >= minMargin
    ? 100 - Math.abs(marginPercent - idealMargin) + (marginPercent > idealMargin ? (marginPercent - idealMargin) * 2 : 0)
    : marginPercent - 50;

  const variety = new Set(packs.map(p => Math.round(p.price))).size;
  score += variety * 3;
  return score;
}

// ─── Subscription Bundle ──────────────────────────────────────────────────────

/**
 * Generate a Chaos Club subscription bundle (3/6/9/12 packs).
 * Returns { packs, targetPrice, metrics, d20Result } or null on failure.
 */
export function generateSubscriptionBundle(regularPacks, collectorPacks, packCount, settings, d20Options = {}) {
  const pricing = settings.subscription_pricing || { 3: 26, 6: 43, 9: 59, 12: 74 };
  const targetPrice = pricing[packCount];
  if (!targetPrice) return null;

  const minMargin = settings.min_margin_percent || 10;
  const idealMargin = settings.ideal_margin_percent || 20;
  const available = regularPacks.filter(p => p.inventory_quantity > 0);

  if (available.length < packCount) return null;

  let bestBundle = null;
  let bestScore = -Infinity;
  const maxAttempts = 200;

  for (let i = 0; i < maxAttempts; i++) {
    let selected;

    if (packCount <= 6) {
      selected = randomSample(available, packCount);
    } else {
      const high = available.filter(p => p.price >= 8.0);
      const low = available.filter(p => p.price < 4.0);
      const targetHigh = Math.min(2, Math.floor(packCount / 4), high.length);
      const targetLow = Math.min(Math.floor(packCount / 3), low.length);
      selected = [
        ...randomSample(high, targetHigh),
        ...randomSample(low, targetLow),
      ];
      const usedIds = new Set(selected.map(p => p.id));
      const remaining = available.filter(p => !usedIds.has(p.id));
      const needed = packCount - selected.length;
      selected = [...selected, ...randomSample(remaining, Math.min(needed, remaining.length))];
    }

    if (selected.length !== packCount) continue;

    const totalCost = selected.reduce((s, p) => s + p.cost, 0);
    const marginPercent = ((targetPrice - totalCost) / targetPrice) * 100;
    const score = scoreBundle(marginPercent, minMargin, idealMargin, selected);

    if (score > bestScore) {
      bestScore = score;
      bestBundle = selected;
    }
    if (marginPercent >= minMargin) break;
  }

  if (!bestBundle) return null;

  // Apply D20 upgrade if requested
  let d20Result = { packs: bestBundle, roll: null, upgraded: false, reason: 'D20 disabled' };
  if (d20Options.enabled) {
    d20Result = rollD20Upgrade(bestBundle, collectorPacks, settings, d20Options.lastUpgradeDate || null);
    bestBundle = d20Result.packs;
  }

  const totalCost = bestBundle.reduce((s, p) => s + p.cost, 0);
  const totalRetail = bestBundle.reduce((s, p) => s + p.price, 0);
  const metrics = {
    total_cost: totalCost,
    total_retail: totalRetail,
    target_price: targetPrice,
    margin_dollars: targetPrice - totalCost,
    margin_percent: ((targetPrice - totalCost) / targetPrice) * 100,
  };

  return { packs: bestBundle, targetPrice, metrics, d20Result };
}

// ─── Advent Calendar Bundle ───────────────────────────────────────────────────

/**
 * Generate an Advent Calendar bundle (23 regular + 1 collector = 24 packs).
 */
export function generateAdventBundle(regularPacks, collectorPacks, settings) {
  const targetPrice = settings.advent_price || 199;
  const minMargin = settings.advent_min_margin_percent || 15;
  const idealMargin = settings.advent_ideal_margin_percent || 25;
  const excludeKeywords = settings.excluded_collector_keywords || ['omega', 'display', 'japanese'];

  const availableRegular = regularPacks.filter(p => p.inventory_quantity > 0);
  const availableCollector = collectorPacks.filter(p => {
    if (p.inventory_quantity <= 0) return false;
    const t = p.product_title.toLowerCase();
    return !excludeKeywords.some(k => t.includes(k)) && !t.includes('aftermath');
  });

  if (availableRegular.length < 23 || !availableCollector.length) return null;

  let bestBundle = null;
  let bestScore = -Infinity;

  for (let i = 0; i < 300; i++) {
    const collector = availableCollector[Math.floor(Math.random() * availableCollector.length)];

    const high = availableRegular.filter(p => p.price >= 8.0);
    const low = availableRegular.filter(p => p.price < 4.0);
    const targetHigh = Math.min(4, high.length);
    const targetLow = Math.min(8, low.length);

    let regular = [...randomSample(high, targetHigh), ...randomSample(low, targetLow)];
    const usedIds = new Set(regular.map(p => p.id));
    const remaining = availableRegular.filter(p => !usedIds.has(p.id));
    regular = [...regular, ...randomSample(remaining, Math.min(23 - regular.length, remaining.length))];

    if (regular.length !== 23) continue;

    const selected = [collector, ...regular];
    const totalCost = selected.reduce((s, p) => s + p.cost, 0);
    const marginPercent = ((targetPrice - totalCost) / targetPrice) * 100;

    let score = marginPercent >= minMargin
      ? 100 - Math.abs(marginPercent - idealMargin) + (marginPercent > idealMargin ? (marginPercent - idealMargin) * 2 : 0)
      : marginPercent - 100;
    score += new Set(regular.map(p => Math.round(p.price))).size * 2;

    if (score > bestScore) {
      bestScore = score;
      bestBundle = selected;
    }
    if (marginPercent >= minMargin) break;
  }

  if (!bestBundle) return null;

  const totalCost = bestBundle.reduce((s, p) => s + p.cost, 0);
  const totalRetail = bestBundle.reduce((s, p) => s + p.price, 0);
  const metrics = {
    total_cost: totalCost,
    total_retail: totalRetail,
    target_price: targetPrice,
    margin_dollars: targetPrice - totalCost,
    margin_percent: ((targetPrice - totalCost) / targetPrice) * 100,
  };

  return { packs: bestBundle, targetPrice, metrics, d20Result: null };
}

// ─── Chaos Draft Kit Bundle ───────────────────────────────────────────────────

/**
 * Generate a Chaos Draft Kit bundle (12 regular + 1 collector = 13 packs).
 */
export function generateDraftKitBundle(regularPacks, collectorPacks, settings) {
  const targetPrice = settings.chaos_draft_price || 120;
  const minMargin = settings.min_margin_percent || 10;
  const idealMargin = settings.ideal_margin_percent || 20;
  const excludeKeywords = settings.draft_suitable_exclude_keywords || ['beyond', 'aftermath'];

  const draftSuitable = regularPacks.filter(p => {
    if (p.inventory_quantity <= 0) return false;
    const t = p.product_title.toLowerCase();
    return !excludeKeywords.some(k => t.includes(k));
  });

  const availableCollector = collectorPacks.filter(p => p.inventory_quantity > 0);

  if (draftSuitable.length < 12 || !availableCollector.length) return null;

  let bestBundle = null;
  let bestScore = -Infinity;

  for (let i = 0; i < 200; i++) {
    const collector = availableCollector[Math.floor(Math.random() * availableCollector.length)];

    const high = draftSuitable.filter(p => p.price >= 6.0);
    let regular = randomSample(high, Math.min(3, high.length));
    const usedIds = new Set(regular.map(p => p.id));
    const remaining = draftSuitable.filter(p => !usedIds.has(p.id));
    regular = [...regular, ...randomSample(remaining, Math.min(12 - regular.length, remaining.length))];

    if (regular.length !== 12) continue;

    const selected = [collector, ...regular];
    const totalCost = selected.reduce((s, p) => s + p.cost, 0);
    const marginPercent = ((targetPrice - totalCost) / targetPrice) * 100;
    const score = scoreBundle(marginPercent, minMargin, idealMargin, regular);

    if (score > bestScore) {
      bestScore = score;
      bestBundle = selected;
    }
    if (marginPercent >= minMargin && new Set(regular.map(p => Math.round(p.price))).size >= 6) break;
  }

  if (!bestBundle) return null;

  const totalCost = bestBundle.reduce((s, p) => s + p.cost, 0);
  const totalRetail = bestBundle.reduce((s, p) => s + p.price, 0);
  const metrics = {
    total_cost: totalCost,
    total_retail: totalRetail,
    target_price: targetPrice,
    margin_dollars: targetPrice - totalCost,
    margin_percent: ((targetPrice - totalCost) / targetPrice) * 100,
  };

  return { packs: bestBundle, targetPrice, metrics, d20Result: null };
}

// ─── Inventory Update ─────────────────────────────────────────────────────────

/**
 * Decrement Shopify inventory for all packs in the bundle.
 * Aggregates duplicates so each product is only updated once.
 * Uses REST adjust endpoint (safe atomic delta).
 */
export async function updateInventory(shopifyApiInstance, session, packs, dryRun = false) {
  // Aggregate by inventory_item_id
  const aggregated = {};
  for (const pack of packs) {
    const itemId = pack.inventory_item_id;
    if (!aggregated[itemId]) {
      aggregated[itemId] = { ...pack, qty: 0 };
    }
    aggregated[itemId].qty++;
  }

  const results = [];
  const client = new shopifyApiInstance.clients.Rest({ session });

  for (const item of Object.values(aggregated)) {
    const numericItemId = gidToNumeric(item.inventory_item_id);

    try {
      // Get current inventory level to obtain location_id
      const levelsResp = await client.get({
        path: 'inventory_levels',
        query: { inventory_item_ids: numericItemId },
      });

      const levels = levelsResp.body.inventory_levels;
      if (!levels || !levels.length) {
        results.push({ name: item.product_title, success: false, reason: 'No inventory level found' });
        continue;
      }

      const locationId = levels[0].location_id;
      const currentQty = levels[0].available;
      const newQty = currentQty - item.qty;

      if (dryRun) {
        results.push({ name: item.product_title, success: true, dryRun: true, from: currentQty, to: newQty, qty: item.qty });
        continue;
      }

      // Apply adjustment
      await client.post({
        path: 'inventory_levels/adjust',
        data: {
          location_id: locationId,
          inventory_item_id: parseInt(numericItemId),
          available_adjustment: -item.qty,
        },
      });

      results.push({ name: item.product_title, success: true, from: currentQty, to: newQty, qty: item.qty, lowStock: newQty < 6 });
    } catch (err) {
      results.push({ name: item.product_title, success: false, reason: err.message });
    }

    // Rate limit safety — 1 call/second
    await new Promise(r => setTimeout(r, 1000));
  }

  return results;
}
