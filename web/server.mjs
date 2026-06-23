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
const wss = new WebSocketServer({ server: httpServer });

function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(ws => { if (ws.readyState === 1) ws.send(msg); });
}

wss.on('connection', ws => {
  // Send full state to new client
  ws.send(JSON.stringify({ type: 'init', products: botManager.getState() }));
});

botManager.on('product:detecting', d => broadcast({ type: 'product:detecting', ...d }));
botManager.on('product:added',    d => broadcast({ type: 'product:added',    ...d }));
botManager.on('product:removed',  d => broadcast({ type: 'product:removed',  ...d }));
botManager.on('product:error',    d => broadcast({ type: 'product:error',    ...d }));
botManager.on('stock:update',     d => broadcast({ type: 'stock:update',     ...d }));

httpServer.listen(port, () => {
  console.log(`\n  PLUGO MONITOR  →  http://localhost:${port}\n`);
});
