/**
 * Database module - supports PostgreSQL (Railway) and SQLite (local dev)
 */

import pg from 'pg';
import { SQLiteSessionStorage } from '@shopify/shopify-app-session-storage-sqlite';
import { Session } from '@shopify/shopify-api';
import Database from 'better-sqlite3';

let pgPool = null;
let sqliteDb = null;
export let sessionStorage = null;

export async function initDatabase() {
  const dbUrl = process.env.DATABASE_URL || '';

  if (dbUrl.startsWith('postgres')) {
    pgPool = new pg.Pool({
      connectionString: dbUrl,
      ssl: dbUrl.includes('railway') ? { rejectUnauthorized: false } : false,
    });
    await setupPostgresTables();
    sessionStorage = createPostgresSessionStorage();
    console.log('✅ PostgreSQL database ready');
  } else {
    sqliteDb = new Database('sessions.db');
    setupSQLiteTables();
    sessionStorage = new SQLiteSessionStorage('sessions.db');
    console.log('✅ SQLite database ready (local dev)');
  }
}

async function ensurePostgresColumn(tableName, columnName, definition) {
  await pgPool.query(`ALTER TABLE ${tableName} ADD COLUMN IF NOT EXISTS ${columnName} ${definition}`);
}

function ensureSQLiteColumn(tableName, columnName, definition) {
  const columns = sqliteDb.prepare(`PRAGMA table_info(${tableName})`).all();
  if (!columns.some(column => column.name === columnName)) {
    sqliteDb.prepare(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`).run();
  }
}

// ─── Table Setup ────────────────────────────────────────────────────────────

async function setupPostgresTables() {
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS shopify_sessions (
      id TEXT PRIMARY KEY,
      shop TEXT NOT NULL,
      state TEXT,
      is_online BOOLEAN DEFAULT FALSE,
      scope TEXT,
      expires INTEGER,
      access_token TEXT,
      online_access_info TEXT
    )
  `);

  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS app_settings (
      shop TEXT PRIMARY KEY,
      settings_json TEXT NOT NULL DEFAULT '{}',
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS chaos_subscribers (
      id SERIAL PRIMARY KEY,
      shop TEXT NOT NULL,
      shopify_customer_id TEXT,
      contract_id TEXT,
      name TEXT NOT NULL,
      email TEXT,
      start_date DATE,
      pack_count INTEGER DEFAULT 3,
      months_renewed INTEGER DEFAULT 0,
      collector_upgrade_count INTEGER DEFAULT 0,
      last_upgrade_date DATE,
      renewal_day INTEGER,
      notes TEXT,
      status TEXT DEFAULT 'active',
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS bundle_history (
      id SERIAL PRIMARY KEY,
      shop TEXT NOT NULL,
      subscriber_id INTEGER REFERENCES chaos_subscribers(id) ON DELETE SET NULL,
      bundle_type TEXT NOT NULL,
      customer_name TEXT,
      pack_count INTEGER,
      total_cost DECIMAL(10,2),
      total_retail DECIMAL(10,2),
      target_price DECIMAL(10,2),
      margin_percent DECIMAL(5,2),
      d20_roll INTEGER,
      d20_upgraded BOOLEAN DEFAULT FALSE,
      packs_json TEXT,
      dry_run BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS docx_templates (
      shop TEXT PRIMARY KEY,
      template_data BYTEA NOT NULL,
      filename TEXT,
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS potm_subscribers (
      id SERIAL PRIMARY KEY,
      shop TEXT NOT NULL,
      shopify_customer_id TEXT,
      name TEXT NOT NULL,
      email TEXT,
      start_date DATE,
      months_renewed INTEGER DEFAULT 0,
      collector_upgrade_count INTEGER DEFAULT 0,
      last_renewal_date DATE,
      last_upgrade_date DATE,
      renewal_day INTEGER,
      notes TEXT,
      status TEXT DEFAULT 'active',
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS potm_order_processing (
      shop TEXT NOT NULL,
      shopify_order_id TEXT NOT NULL,
      shopify_order_name TEXT,
      potm_subscriber_id INTEGER REFERENCES potm_subscribers(id) ON DELETE SET NULL,
      renewal_processed BOOLEAN DEFAULT FALSE,
      renewal_date DATE,
      months_after INTEGER,
      upgrade_due BOOLEAN DEFAULT FALSE,
      discord_alert_sent BOOLEAN DEFAULT FALSE,
      upgrade_line_item_added BOOLEAN DEFAULT FALSE,
      order_edit_message TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW(),
      PRIMARY KEY (shop, shopify_order_id)
    )
  `);

  await ensurePostgresColumn('potm_subscribers', 'last_renewal_date', 'DATE');
}

function setupSQLiteTables() {
  sqliteDb.exec(`
    CREATE TABLE IF NOT EXISTS app_settings (
      shop TEXT PRIMARY KEY,
      settings_json TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS chaos_subscribers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shop TEXT NOT NULL,
      shopify_customer_id TEXT,
      contract_id TEXT,
      name TEXT NOT NULL,
      email TEXT,
      start_date TEXT,
      pack_count INTEGER DEFAULT 3,
      months_renewed INTEGER DEFAULT 0,
      collector_upgrade_count INTEGER DEFAULT 0,
      last_upgrade_date TEXT,
      renewal_day INTEGER,
      notes TEXT,
      status TEXT DEFAULT 'active',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS bundle_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shop TEXT NOT NULL,
      subscriber_id INTEGER,
      bundle_type TEXT NOT NULL,
      customer_name TEXT,
      pack_count INTEGER,
      total_cost REAL,
      total_retail REAL,
      target_price REAL,
      margin_percent REAL,
      d20_roll INTEGER,
      d20_upgraded INTEGER DEFAULT 0,
      packs_json TEXT,
      dry_run INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS docx_templates (
      shop TEXT PRIMARY KEY,
      template_data BLOB NOT NULL,
      filename TEXT,
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS potm_subscribers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shop TEXT NOT NULL,
      shopify_customer_id TEXT,
      name TEXT NOT NULL,
      email TEXT,
      start_date TEXT,
      months_renewed INTEGER DEFAULT 0,
      collector_upgrade_count INTEGER DEFAULT 0,
      last_renewal_date TEXT,
      last_upgrade_date TEXT,
      renewal_day INTEGER,
      notes TEXT,
      status TEXT DEFAULT 'active',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS potm_order_processing (
      shop TEXT NOT NULL,
      shopify_order_id TEXT NOT NULL,
      shopify_order_name TEXT,
      potm_subscriber_id INTEGER,
      renewal_processed INTEGER DEFAULT 0,
      renewal_date TEXT,
      months_after INTEGER,
      upgrade_due INTEGER DEFAULT 0,
      discord_alert_sent INTEGER DEFAULT 0,
      upgrade_line_item_added INTEGER DEFAULT 0,
      order_edit_message TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (shop, shopify_order_id)
    );
  `);

  ensureSQLiteColumn('potm_subscribers', 'last_renewal_date', 'TEXT');
}

// ─── PostgreSQL Session Storage ──────────────────────────────────────────────

function createPostgresSessionStorage() {
  return {
    async storeSession(session) {
      await pgPool.query(
        `INSERT INTO shopify_sessions (id, shop, state, is_online, scope, expires, access_token)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (id) DO UPDATE SET
           shop = EXCLUDED.shop, state = EXCLUDED.state, is_online = EXCLUDED.is_online,
           scope = EXCLUDED.scope, expires = EXCLUDED.expires, access_token = EXCLUDED.access_token`,
        [session.id, session.shop, session.state, session.isOnline, session.scope, session.expires, session.accessToken]
      );
      return true;
    },
    async loadSession(id) {
      const result = await pgPool.query('SELECT * FROM shopify_sessions WHERE id = $1', [id]);
      if (!result.rows.length) return undefined;
      const r = result.rows[0];
      return new Session({ id: r.id, shop: r.shop, state: r.state, isOnline: r.is_online, scope: r.scope, expires: r.expires ? new Date(r.expires) : undefined, accessToken: r.access_token });
    },
    async deleteSession(id) {
      await pgPool.query('DELETE FROM shopify_sessions WHERE id = $1', [id]);
      return true;
    },
    async deleteSessions(ids) {
      await pgPool.query('DELETE FROM shopify_sessions WHERE id = ANY($1)', [ids]);
      return true;
    },
    async findSessionsByShop(shop) {
      const result = await pgPool.query('SELECT * FROM shopify_sessions WHERE shop = $1', [shop]);
      return result.rows.map(r => new Session({ id: r.id, shop: r.shop, state: r.state, isOnline: r.is_online, scope: r.scope, expires: r.expires ? new Date(r.expires) : undefined, accessToken: r.access_token }));
    },
  };
}

// ─── Settings ────────────────────────────────────────────────────────────────

export function getDefaultSettings() {
  return {
    regular_pack_ids: [],
    collector_pack_ids: [],
    chaos_club_product_id: '',
    potm_product_id: '',
    potm_upgrade_interval_months: 6,
    potm_discord_webhook_url: '',
    potm_discord_webhook_mentions: '',
    subscription_pricing: { 3: 26, 6: 43, 9: 59, 12: 74 },
    shipping_cost: 8,
    min_margin_percent: 10,
    ideal_margin_percent: 20,
    advent_min_margin_percent: 15,
    advent_ideal_margin_percent: 25,
    chaos_draft_price: 120,
    advent_price: 199,
    collector_upgrade_max_price: 50,
    luck_protection_months: 12,
    draft_suitable_exclude_keywords: ['beyond', 'aftermath'],
    excluded_collector_keywords: ['omega', 'display', 'japanese'],
  };
}

export async function getSettings(shop) {
  if (pgPool) {
    const result = await pgPool.query('SELECT settings_json FROM app_settings WHERE shop = $1', [shop]);
    return result.rows.length ? { ...getDefaultSettings(), ...JSON.parse(result.rows[0].settings_json) } : getDefaultSettings();
  } else {
    const row = sqliteDb.prepare('SELECT settings_json FROM app_settings WHERE shop = ?').get(shop);
    return row ? { ...getDefaultSettings(), ...JSON.parse(row.settings_json) } : getDefaultSettings();
  }
}

export async function saveSettings(shop, settings) {
  const json = JSON.stringify(settings);
  if (pgPool) {
    await pgPool.query(
      `INSERT INTO app_settings (shop, settings_json, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (shop) DO UPDATE SET settings_json = $2, updated_at = NOW()`,
      [shop, json]
    );
  } else {
    sqliteDb.prepare('INSERT OR REPLACE INTO app_settings (shop, settings_json) VALUES (?, ?)').run(shop, json);
  }
}

// ─── Subscribers ─────────────────────────────────────────────────────────────

export async function getSubscribers(shop) {
  if (pgPool) {
    const result = await pgPool.query('SELECT * FROM chaos_subscribers WHERE shop = $1 ORDER BY name', [shop]);
    return result.rows;
  } else {
    return sqliteDb.prepare('SELECT * FROM chaos_subscribers WHERE shop = ? ORDER BY name').all(shop);
  }
}

export async function getSubscriberByCustomerId(shop, shopifyCustomerId) {
  if (pgPool) {
    const result = await pgPool.query(
      'SELECT * FROM chaos_subscribers WHERE shop = $1 AND shopify_customer_id = $2 AND status = $3',
      [shop, shopifyCustomerId, 'active']
    );
    return result.rows[0] || null;
  } else {
    return sqliteDb.prepare(
      'SELECT * FROM chaos_subscribers WHERE shop = ? AND shopify_customer_id = ? AND status = ?'
    ).get(shop, shopifyCustomerId, 'active') || null;
  }
}

export async function getSubscriber(shop, id) {
  if (pgPool) {
    const result = await pgPool.query('SELECT * FROM chaos_subscribers WHERE shop = $1 AND id = $2', [shop, id]);
    return result.rows[0] || null;
  } else {
    return sqliteDb.prepare('SELECT * FROM chaos_subscribers WHERE shop = ? AND id = ?').get(shop, id) || null;
  }
}

export async function createSubscriber(shop, data) {
  const fields = ['shopify_customer_id', 'contract_id', 'name', 'email', 'start_date', 'pack_count', 'months_renewed', 'collector_upgrade_count', 'last_upgrade_date', 'renewal_day', 'notes', 'status'];
  const values = [data.shopify_customer_id || null, data.contract_id || null, data.name, data.email || null, data.start_date || null, data.pack_count || 3, data.months_renewed || 0, data.collector_upgrade_count || 0, data.last_upgrade_date || null, data.renewal_day || null, data.notes || null, data.status || 'active'];

  if (pgPool) {
    const placeholders = fields.map((_, i) => `$${i + 2}`).join(', ');
    const result = await pgPool.query(
      `INSERT INTO chaos_subscribers (shop, ${fields.join(', ')}) VALUES ($1, ${placeholders}) RETURNING *`,
      [shop, ...values]
    );
    return result.rows[0];
  } else {
    const placeholders = fields.map(() => '?').join(', ');
    const info = sqliteDb.prepare(
      `INSERT INTO chaos_subscribers (shop, ${fields.join(', ')}) VALUES (?, ${placeholders})`
    ).run(shop, ...values);
    return sqliteDb.prepare('SELECT * FROM chaos_subscribers WHERE id = ?').get(info.lastInsertRowid);
  }
}

export async function updateSubscriber(shop, id, data) {
  const fields = ['name', 'email', 'start_date', 'pack_count', 'months_renewed', 'collector_upgrade_count', 'last_upgrade_date', 'renewal_day', 'notes', 'status', 'shopify_customer_id', 'contract_id'];
  const values = fields.map(f => (data[f] !== undefined ? data[f] : null));

  if (pgPool) {
    const sets = fields.map((f, i) => `${f} = $${i + 3}`).join(', ');
    const result = await pgPool.query(
      `UPDATE chaos_subscribers SET ${sets}, updated_at = NOW() WHERE shop = $1 AND id = $2 RETURNING *`,
      [shop, id, ...values]
    );
    return result.rows[0] || null;
  } else {
    const sets = fields.map(f => `${f} = ?`).join(', ');
    sqliteDb.prepare(
      `UPDATE chaos_subscribers SET ${sets}, updated_at = datetime('now') WHERE shop = ? AND id = ?`
    ).run(...values, shop, id);
    return sqliteDb.prepare('SELECT * FROM chaos_subscribers WHERE id = ?').get(id) || null;
  }
}

export async function deleteSubscriber(shop, id) {
  if (pgPool) {
    await pgPool.query('DELETE FROM chaos_subscribers WHERE shop = $1 AND id = $2', [shop, id]);
  } else {
    sqliteDb.prepare('DELETE FROM chaos_subscribers WHERE shop = ? AND id = ?').run(shop, id);
  }
}

// ─── Bundle History ───────────────────────────────────────────────────────────

export async function saveBundleHistory(shop, data) {
  const cols = ['subscriber_id', 'bundle_type', 'customer_name', 'pack_count', 'total_cost', 'total_retail', 'target_price', 'margin_percent', 'd20_roll', 'd20_upgraded', 'packs_json', 'dry_run'];
  const vals = [
    data.subscriber_id || null,
    data.bundle_type,
    data.customer_name || null,
    data.pack_count || null,
    data.total_cost || null,
    data.total_retail || null,
    data.target_price || null,
    data.margin_percent || null,
    data.d20_roll || null,
    data.d20_upgraded || false,
    JSON.stringify(data.packs || []),
    data.dry_run || false,
  ];

  if (pgPool) {
    const placeholders = cols.map((_, i) => `$${i + 2}`).join(', ');
    const result = await pgPool.query(
      `INSERT INTO bundle_history (shop, ${cols.join(', ')}) VALUES ($1, ${placeholders}) RETURNING *`,
      [shop, ...vals]
    );
    return result.rows[0];
  } else {
    const placeholders = cols.map(() => '?').join(', ');
    const info = sqliteDb.prepare(
      `INSERT INTO bundle_history (shop, ${cols.join(', ')}) VALUES (?, ${placeholders})`
    ).run(shop, ...vals.map(v => (typeof v === 'boolean' ? (v ? 1 : 0) : v)));
    return sqliteDb.prepare('SELECT * FROM bundle_history WHERE id = ?').get(info.lastInsertRowid);
  }
}

export async function getBundleHistory(shop, limit = 50) {
  if (pgPool) {
    const result = await pgPool.query(
      `SELECT bh.*, cs.name AS subscriber_name
       FROM bundle_history bh
       LEFT JOIN chaos_subscribers cs ON bh.subscriber_id = cs.id
       WHERE bh.shop = $1
       ORDER BY bh.created_at DESC LIMIT $2`,
      [shop, limit]
    );
    return result.rows;
  } else {
    return sqliteDb.prepare(
      `SELECT bh.*, cs.name AS subscriber_name
       FROM bundle_history bh
       LEFT JOIN chaos_subscribers cs ON bh.subscriber_id = cs.id
       WHERE bh.shop = ? ORDER BY bh.created_at DESC LIMIT ?`
    ).all(shop, limit);
  }
}

export async function getBundleById(shop, id) {
  if (pgPool) {
    const result = await pgPool.query('SELECT * FROM bundle_history WHERE shop = $1 AND id = $2', [shop, id]);
    return result.rows[0] || null;
  } else {
    return sqliteDb.prepare('SELECT * FROM bundle_history WHERE shop = ? AND id = ?').get(shop, id) || null;
  }
}

// ─── DOCX Templates ─────────────────────────────────────────────────────

export async function saveDOCXTemplate(shop, buffer, filename) {
  if (pgPool) {
    await pgPool.query(
      `INSERT INTO docx_templates (shop, template_data, filename, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (shop) DO UPDATE SET template_data = EXCLUDED.template_data, filename = EXCLUDED.filename, updated_at = NOW()`,
      [shop, buffer, filename || 'template.docx']
    );
  } else {
    sqliteDb.prepare(
      `INSERT INTO docx_templates (shop, template_data, filename, updated_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(shop) DO UPDATE SET template_data = excluded.template_data, filename = excluded.filename, updated_at = datetime('now')`
    ).run(shop, buffer, filename || 'template.docx');
  }
}

export async function getDOCXTemplate(shop) {
  if (pgPool) {
    const result = await pgPool.query('SELECT template_data, filename FROM docx_templates WHERE shop = $1', [shop]);
    if (!result.rows.length) return null;
    return { buffer: result.rows[0].template_data, filename: result.rows[0].filename };
  } else {
    const row = sqliteDb.prepare('SELECT template_data, filename FROM docx_templates WHERE shop = ?').get(shop);
    if (!row) return null;
    return { buffer: Buffer.from(row.template_data), filename: row.filename };
  }
}

export async function deleteDOCXTemplate(shop) {
  if (pgPool) {
    await pgPool.query('DELETE FROM docx_templates WHERE shop = $1', [shop]);
  } else {
    sqliteDb.prepare('DELETE FROM docx_templates WHERE shop = ?').run(shop);
  }
}

// ─── POTM Subscribers ────────────────────────────────────────────────────────

export async function getPotmSubscribers(shop) {
  if (pgPool) {
    const result = await pgPool.query('SELECT * FROM potm_subscribers WHERE shop = $1 ORDER BY name', [shop]);
    return result.rows;
  } else {
    return sqliteDb.prepare('SELECT * FROM potm_subscribers WHERE shop = ? ORDER BY name').all(shop);
  }
}

export async function getPotmSubscriber(shop, id) {
  if (pgPool) {
    const result = await pgPool.query('SELECT * FROM potm_subscribers WHERE shop = $1 AND id = $2', [shop, id]);
    return result.rows[0] || null;
  } else {
    return sqliteDb.prepare('SELECT * FROM potm_subscribers WHERE shop = ? AND id = ?').get(shop, id) || null;
  }
}

export async function getPotmSubscriberByCustomerId(shop, shopifyCustomerId) {
  if (pgPool) {
    const result = await pgPool.query(
      'SELECT * FROM potm_subscribers WHERE shop = $1 AND shopify_customer_id = $2 AND status = $3',
      [shop, shopifyCustomerId, 'active']
    );
    return result.rows[0] || null;
  } else {
    return sqliteDb.prepare(
      'SELECT * FROM potm_subscribers WHERE shop = ? AND shopify_customer_id = ? AND status = ?'
    ).get(shop, shopifyCustomerId, 'active') || null;
  }
}

export async function createPotmSubscriber(shop, data) {
  const fields = ['shopify_customer_id', 'name', 'email', 'start_date', 'months_renewed', 'collector_upgrade_count', 'last_renewal_date', 'last_upgrade_date', 'renewal_day', 'notes', 'status'];
  const values = [data.shopify_customer_id || null, data.name, data.email || null, data.start_date || null, data.months_renewed || 0, data.collector_upgrade_count || 0, data.last_renewal_date || null, data.last_upgrade_date || null, data.renewal_day || null, data.notes || null, data.status || 'active'];

  if (pgPool) {
    const placeholders = fields.map((_, i) => `$${i + 2}`).join(', ');
    const result = await pgPool.query(
      `INSERT INTO potm_subscribers (shop, ${fields.join(', ')}) VALUES ($1, ${placeholders}) RETURNING *`,
      [shop, ...values]
    );
    return result.rows[0];
  } else {
    const placeholders = fields.map(() => '?').join(', ');
    const info = sqliteDb.prepare(
      `INSERT INTO potm_subscribers (shop, ${fields.join(', ')}) VALUES (?, ${placeholders})`
    ).run(shop, ...values);
    return sqliteDb.prepare('SELECT * FROM potm_subscribers WHERE id = ?').get(info.lastInsertRowid);
  }
}

export async function updatePotmSubscriber(shop, id, data) {
  const fields = ['name', 'email', 'start_date', 'months_renewed', 'collector_upgrade_count', 'last_renewal_date', 'last_upgrade_date', 'renewal_day', 'notes', 'status', 'shopify_customer_id'];
  const values = fields.map(f => (data[f] !== undefined ? data[f] : null));

  if (pgPool) {
    const sets = fields.map((f, i) => `${f} = $${i + 3}`).join(', ');
    const result = await pgPool.query(
      `UPDATE potm_subscribers SET ${sets}, updated_at = NOW() WHERE shop = $1 AND id = $2 RETURNING *`,
      [shop, id, ...values]
    );
    return result.rows[0] || null;
  } else {
    const sets = fields.map(f => `${f} = ?`).join(', ');
    sqliteDb.prepare(
      `UPDATE potm_subscribers SET ${sets}, updated_at = datetime('now') WHERE shop = ? AND id = ?`
    ).run(...values, shop, id);
    return sqliteDb.prepare('SELECT * FROM potm_subscribers WHERE id = ?').get(id) || null;
  }
}

export async function deletePotmSubscriber(shop, id) {
  if (pgPool) {
    await pgPool.query('DELETE FROM potm_subscribers WHERE shop = $1 AND id = $2', [shop, id]);
  } else {
    sqliteDb.prepare('DELETE FROM potm_subscribers WHERE shop = ? AND id = ?').run(shop, id);
  }
}

export async function getPotmOrderProcessing(shop, shopifyOrderId) {
  if (pgPool) {
    const result = await pgPool.query(
      'SELECT * FROM potm_order_processing WHERE shop = $1 AND shopify_order_id = $2',
      [shop, shopifyOrderId]
    );
    return result.rows[0] || null;
  } else {
    return sqliteDb.prepare(
      'SELECT * FROM potm_order_processing WHERE shop = ? AND shopify_order_id = ?'
    ).get(shop, shopifyOrderId) || null;
  }
}

export async function savePotmOrderProcessing(shop, shopifyOrderId, data) {
  const fields = [
    'shopify_order_name',
    'potm_subscriber_id',
    'renewal_processed',
    'renewal_date',
    'months_after',
    'upgrade_due',
    'discord_alert_sent',
    'upgrade_line_item_added',
    'order_edit_message',
  ];
  const values = fields.map(field => (data[field] !== undefined ? data[field] : null));

  if (pgPool) {
    const updateAssignments = fields.map((field, index) => `${field} = $${index + 3}`).join(', ');
    const result = await pgPool.query(
      `INSERT INTO potm_order_processing (shop, shopify_order_id, ${fields.join(', ')}, created_at, updated_at)
       VALUES ($1, $2, ${fields.map((_, index) => `$${index + 3}`).join(', ')}, NOW(), NOW())
       ON CONFLICT (shop, shopify_order_id) DO UPDATE SET ${updateAssignments}, updated_at = NOW()
       RETURNING *`,
      [shop, shopifyOrderId, ...values]
    );
    return result.rows[0] || null;
  } else {
    sqliteDb.prepare(
      `INSERT INTO potm_order_processing (shop, shopify_order_id, ${fields.join(', ')}, created_at, updated_at)
       VALUES (?, ?, ${fields.map(() => '?').join(', ')}, datetime('now'), datetime('now'))
       ON CONFLICT(shop, shopify_order_id) DO UPDATE SET
         ${fields.map(field => `${field} = excluded.${field}`).join(', ')},
         updated_at = datetime('now')`
    ).run(shop, shopifyOrderId, ...values.map(value => (typeof value === 'boolean' ? (value ? 1 : 0) : value)));

    return getPotmOrderProcessing(shop, shopifyOrderId);
  }
}
