import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ADVENT_GUARANTEED_PACKS,
  fetchBundleProducts,
  generateAdventBundle,
} from './bundleGenerator.js';

test('fetches guaranteed Advent packs even when inactive or out of stock', async () => {
  const products = ADVENT_GUARANTEED_PACKS.map((pack, index) => ({
    id: pack.productId,
    title: `Guaranteed pack ${index + 1}`,
    status: 'ARCHIVED',
    variants: {
      nodes: [{
        id: `gid://shopify/ProductVariant/${index + 1}`,
        title: 'Default Title',
        sku: pack.sku,
        price: '0.00',
        inventoryQuantity: index === 0 ? 0 : -1,
        inventoryItem: {
          id: `gid://shopify/InventoryItem/${index + 1}`,
          unitCost: null,
        },
      }],
    },
  }));

  const client = {
    async request(_query, { variables }) {
      assert.deepEqual(variables.ids, ADVENT_GUARANTEED_PACKS.map(pack => pack.productId));
      return { data: { nodes: products } };
    },
  };

  const result = await fetchBundleProducts(client, [], [], ADVENT_GUARANTEED_PACKS);

  assert.equal(result.regular.length, 0);
  assert.equal(result.collector.length, 0);
  assert.equal(result.guaranteed.length, 2);
  assert.deepEqual(result.guaranteed.map(pack => pack.price), [29, 25]);
  assert.deepEqual(result.guaranteed.map(pack => pack.cost), [21.17, 11.07]);
  assert.deepEqual(result.guaranteed.map(pack => pack.inventory_quantity), [0, -1]);
  assert.ok(result.guaranteed.every(pack => pack.is_guaranteed));
});

test('generates 24 Advent packs with two guaranteed packs regardless of their stock', () => {
  const regular = Array.from({ length: 22 }, (_, index) => ({
    id: `regular-${index}`,
    product_title: `Regular ${index + 1}`,
    price: 5,
    cost: 1,
    inventory_quantity: index < 21 ? 1 : 0,
    inventory_item_id: `regular-item-${index}`,
    is_collector: false,
  }));
  const collector = [{
    id: 'collector',
    product_title: 'Collector pack',
    price: 40,
    cost: 5,
    inventory_quantity: 1,
    inventory_item_id: 'collector-item',
    is_collector: true,
  }];
  const guaranteed = ADVENT_GUARANTEED_PACKS.map((pack, index) => ({
    id: `guaranteed-${index}`,
    product_id: pack.productId,
    product_title: `Guaranteed ${index + 1}`,
    price: pack.price,
    cost: pack.cost,
    inventory_quantity: index === 0 ? 0 : -1,
    inventory_item_id: `guaranteed-item-${index}`,
    is_collector: false,
    is_guaranteed: true,
  }));

  const result = generateAdventBundle(regular, collector, {
    advent_price: 249,
    advent_min_margin_percent: 30,
    advent_ideal_margin_percent: 50,
  }, guaranteed);

  assert.equal(result.packs.length, 24);
  assert.equal(result.packs.filter(pack => pack.is_collector).length, 1);
  assert.equal(result.packs.filter(pack => pack.is_guaranteed).length, 2);
  assert.equal(result.packs.filter(pack => !pack.is_collector && !pack.is_guaranteed).length, 21);
  assert.ok(result.packs.every(pack => pack.is_guaranteed || pack.inventory_quantity > 0));
  assert.equal(result.metrics.target_price, 249);
  assert.equal(result.metrics.total_retail, 199);
  assert.equal(Math.round(result.metrics.total_cost * 100) / 100, 58.24);
  assert.ok(result.metrics.margin_percent >= 30);
});

test('evaluates later candidates toward the Advent ideal margin', () => {
  const regular = [
    ...Array.from({ length: 21 }, (_, index) => ({
      id: `regular-${index}`,
      product_title: `Regular ${index + 1}`,
      price: 5,
      cost: 1,
      inventory_quantity: 1,
      inventory_item_id: `regular-item-${index}`,
      is_collector: false,
    })),
    {
      id: 'high-cost',
      product_title: 'High-cost pack',
      price: 5,
      cost: 10,
      inventory_quantity: 1,
      inventory_item_id: 'high-cost-item',
      is_collector: false,
    },
  ];
  const collector = [{
    id: 'collector',
    product_title: 'Collector pack',
    price: 40,
    cost: 1,
    inventory_quantity: 1,
    inventory_item_id: 'collector-item',
    is_collector: true,
  }];
  const guaranteed = ADVENT_GUARANTEED_PACKS.map((pack, index) => ({
    id: `guaranteed-${index}`,
    product_id: pack.productId,
    product_title: `Guaranteed ${index + 1}`,
    price: pack.price,
    cost: pack.cost,
    inventory_quantity: 1,
    inventory_item_id: `guaranteed-item-${index}`,
    is_collector: false,
    is_guaranteed: true,
  }));
  const originalRandom = Math.random;
  let randomCalls = 0;
  Math.random = () => (randomCalls++ < 22 ? 0 : 0.999999);

  let result;
  try {
    result = generateAdventBundle(regular, collector, {
      advent_price: 249,
      advent_min_margin_percent: 30,
      advent_ideal_margin_percent: 50,
    }, guaranteed);
  } finally {
    Math.random = originalRandom;
  }

  assert.ok(result);
  assert.ok(result.metrics.margin_percent > 50);
  assert.ok(!result.packs.some(pack => pack.id === 'high-cost'));
});

test('refuses to generate an Advent bundle below the minimum margin', () => {
  const regular = Array.from({ length: 21 }, (_, index) => ({
    id: `regular-${index}`,
    product_title: `Regular ${index + 1}`,
    price: 5,
    cost: 7,
    inventory_quantity: 1,
    inventory_item_id: `regular-item-${index}`,
    is_collector: false,
  }));
  const collector = [{
    id: 'collector',
    product_title: 'Collector pack',
    price: 40,
    cost: 40,
    inventory_quantity: 1,
    inventory_item_id: 'collector-item',
    is_collector: true,
  }];
  const guaranteed = ADVENT_GUARANTEED_PACKS.map((pack, index) => ({
    id: `guaranteed-${index}`,
    product_id: pack.productId,
    product_title: `Guaranteed ${index + 1}`,
    price: pack.price,
    cost: pack.cost,
    inventory_quantity: 1,
    inventory_item_id: `guaranteed-item-${index}`,
    is_collector: false,
    is_guaranteed: true,
  }));

  const result = generateAdventBundle(regular, collector, {
    advent_price: 249,
    advent_min_margin_percent: 30,
    advent_ideal_margin_percent: 50,
  }, guaranteed);

  assert.equal(result, null);
});
