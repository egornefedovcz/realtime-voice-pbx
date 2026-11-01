#!/usr/bin/env node
// Entry point.
//   TRANSPORT  comma-separated: yeastar | asterisk-ari | asterisk-audiosocket | twilio
//   AGENT      path to a module exporting an agent (defineAgent result), default: examples/pottery-studio
const path = require('path');
const http = require('http');
const WebSocket = require('ws');
const { str, num, OPENAI_API_KEY } = require('../packages/core/config');

const TRANSPORTS = ['yeastar', 'asterisk-ari', 'asterisk-audiosocket', 'twilio'];

function loadAgent() {
  const p = str('AGENT', path.join(__dirname, '..', 'examples', 'pottery-studio'));
  const mod = require(path.resolve(process.cwd(), p));
  const agent = mod.agent || mod.default || mod;
  if (!agent || typeof agent.instructions !== 'function') throw new Error(`AGENT ${p} does not export an agent created with defineAgent()`);
  return agent;
}

function main() {
  if (!OPENAI_API_KEY) console.error('[START] OPENAI_API_KEY is not set — calls will fail');
  const agent = loadAgent();
  const selected = str('TRANSPORT', 'yeastar').split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
  for (const t of selected) if (!TRANSPORTS.includes(t)) throw new Error(`unknown TRANSPORT "${t}" (use: ${TRANSPORTS.join(', ')})`);

  // Tiny router shared by the HTTP/WebSocket based transports
  const routes = [];
  const sockets = [];
  const router = {
    onRequest: (method, p, fn) => routes.push({ method, path: p, fn }),
    onWebSocket: (p, fn) => sockets.push({ path: p, fn }),
  };
  const wss = new WebSocket.Server({ noServer: true });
  const server = http.createServer((req, res) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    if (pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', agent: agent.name, transports: selected }));
      return;
    }
    const route = routes.find((r) => r.method === req.method && r.path === pathname);
    if (!route) { res.writeHead(404); res.end(); return; }
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => {
      try { route.fn(req, res, body); } catch (e) { console.error('[HTTP]', e.message); res.writeHead(500); res.end(); }
    });
  });
  server.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    const target = sockets.find((s) => pathname.startsWith(s.path));
    if (!target) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => target.fn(ws, req));
  });

  for (const t of selected) require(`../transports/${t}`).start({ agent, http: router });

  const port = num('PORT', 8080);
  server.listen(port, str('HOST', '0.0.0.0'), () => {
    console.log(`[START] agent "${agent.name}", transports: ${selected.join(', ')}, HTTP on :${port}`);
  });
}

main();
