import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import next from 'next';
import { botManager } from './lib/bot-manager.js';

const dev  = process.env.NODE_ENV !== 'production';
const port = parseInt(process.env.PORT ?? '3000', 10);
const app  = next({ dev, port });
const handle = app.getRequestHandler();

await app.prepare();

const httpServer = createServer((req, res) => handle(req, res));
const wss = new WebSocketServer({ noServer: true });
const upgradeHandler = app.getUpgradeHandler();

// Only intercept /ws — let Next.js handle HMR upgrades
httpServer.on('upgrade', (req, socket, head) => {
  if (req.url === '/ws') {
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  } else {
    upgradeHandler(req, socket, head);
  }
});

function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(ws => { if (ws.readyState === 1) ws.send(msg); });
}

wss.on('connection', ws => {
  ws.send(JSON.stringify({ type: 'init', products: botManager.getState() }));
});

botManager.on('product:detecting',  d => broadcast({ type: 'product:detecting',  ...d }));
botManager.on('product:added',     d => broadcast({ type: 'product:added',     ...d }));
botManager.on('product:removed',   d => broadcast({ type: 'product:removed',   ...d }));
botManager.on('product:error',     d => broadcast({ type: 'product:error',     ...d }));
botManager.on('stock:update',      d => broadcast({ type: 'stock:update',      ...d }));
botManager.on('collection:scanning', d => broadcast({ type: 'collection:scanning', ...d }));
botManager.on('collection:found',    d => broadcast({ type: 'collection:found',    ...d }));
botManager.on('collection:error',    d => broadcast({ type: 'collection:error',    ...d }));

httpServer.listen(port, () => {
  console.log(`\n  PLUGO MONITOR  →  http://localhost:${port}\n`);
});
