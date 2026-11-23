#!/usr/bin/env node
// Independent backup logger for a drop: polls the shop's product list, and for
// every product NOT present at startup (i.e. new launches) fetches stock every
// INTERVAL ms and appends one JSON line per poll to data/backup-<shop>.jsonl.
// Usage: node src/backup-logger.js https://www.calledelarache.com/ [intervalMs] [nameMatch]
// nameMatch (e.g. FRAGRANCIA): also track existing products whose URL slug contains it.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { scanCollectionPage, detectPlugoEndpoint } from './detector.js';

const shopUrl  = process.argv[2] ?? 'https://www.calledelarache.com/';
const INTERVAL = parseInt(process.argv[3] ?? '5000', 10);
const MATCH    = (process.argv[4] ?? '').toLowerCase();
const ROOT     = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const host     = new URL(shopUrl).hostname.replace(/^www\./, '');
const OUT      = path.join(ROOT, 'data', `backup-${host}.jsonl`);
fs.mkdirSync(path.dirname(OUT), { recursive: true });

const idOf = (u) => (u.match(/\/products\/(\d+)/) ?? [])[1];
const write = (obj) => fs.appendFileSync(OUT, JSON.stringify({ t: new Date().toISOString(), ...obj }) + '\n');

const baseline = new Set((await scanCollectionPage(shopUrl)).map(idOf));
const tracked  = new Map(); // id → url
console.log(`[backup] baseline ${baseline.size} products; logging new ones to ${OUT}`);
write({ event: 'start', baseline: [...baseline] });

async function tick() {
  try {
    for (const u of await scanCollectionPage(shopUrl)) {
      const id = idOf(u);
      const matches = MATCH && u.toLowerCase().includes(MATCH);
      if (id && (!baseline.has(id) || matches) && !tracked.has(id)) {
        tracked.set(id, u);
        console.log(`[backup] ${matches ? 'TRACK' : 'NEW'} product ${u}`);
        write({ event: matches ? 'track_product' : 'new_product', id, url: u });
      }
    }
  } catch (e) { write({ event: 'scan_error', error: e.message }); }

  await Promise.all([...tracked].map(async ([id, u]) => {
    try {
      const r = await detectPlugoEndpoint(u, () => {});
      if (r) write({ event: 'stock', id, name: r.initial.productName, variants: r.initial.variants });
      else write({ event: 'stock_error', id, error: 'no data' });
    } catch (e) { write({ event: 'stock_error', id, error: e.message }); }
  }));
  setTimeout(tick, INTERVAL);
}
tick();
