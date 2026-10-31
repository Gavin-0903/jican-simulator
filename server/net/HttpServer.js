// HTTP：静态托管 client/ 与 shared/、地图与大厅 API、本地调试端点。只允许 GET/HEAD，防目录穿越。

import { createReadStream, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { isLoopbackHost } from './WsServer.js';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8',
};

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-cache',
};

const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: wss:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

function safeJoin(base, rel) {
  const target = resolve(base, normalize(`.${sep}${rel}`));
  return target === base || target.startsWith(base + sep) ? target : null;
}

export function createHttpHandler({ rootDir, controller, map, host, debug = true, logger = console }) {
  const clientDir = resolve(rootDir, 'client');
  const sharedDir = resolve(rootDir, 'shared');
  const mapView = JSON.stringify(map.publicView());

  const sendJson = (res, code, body) => {
    res.writeHead(code, { ...SECURITY_HEADERS, 'content-type': TYPES['.json'] });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  };

  const sendFile = (req, res, file) => {
    let st;
    try {
      st = statSync(file);
    } catch {
      st = null;
    }
    if (!st || !st.isFile()) {
      res.writeHead(404, { ...SECURITY_HEADERS, 'content-type': 'text/plain; charset=utf-8' });
      return res.end('Not Found');
    }
    const type = TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream';
    const headers = { ...SECURITY_HEADERS, 'content-type': type, 'content-length': st.size };
    if (type.startsWith('text/html')) headers['content-security-policy'] = CSP;
    res.writeHead(200, headers);
    if (req.method === 'HEAD') return res.end();
    createReadStream(file).pipe(res);
  };

  return (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { ...SECURITY_HEADERS, allow: 'GET, HEAD' });
      return res.end();
    }
    // 绑定回环地址时校验 Host，防 DNS 重绑定
    const hostHeader = (req.headers.host || '').replace(/:\d+$/, '');
    if (isLoopbackHost(host) && !isLoopbackHost(hostHeader)) {
      res.writeHead(403, SECURITY_HEADERS);
      return res.end();
    }
    let path;
    try {
      path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    } catch {
      res.writeHead(400, SECURITY_HEADERS);
      return res.end();
    }
    if (path === '/' || path === '/index.html') return sendFile(req, res, join(clientDir, 'index.html'));
    if (path === '/favicon.ico') return sendFile(req, res, join(clientDir, 'assets', 'icons', 'favicon.svg'));
    if (path === '/api/map') return sendJson(res, 200, mapView);
    if (path === '/api/lobby') return sendJson(res, 200, controller.lobbyInfo());
    if (debug && path === '/debug/llm-status') return sendJson(res, 200, controller.llmStatus());
    if (debug && path === '/debug/health') return sendJson(res, 200, controller.health());
    let file = null;
    if (path.startsWith('/shared/')) file = safeJoin(sharedDir, path.slice('/shared/'.length));
    else if (/^\/(css|js|assets)\//.test(path)) file = safeJoin(clientDir, path.slice(1));
    if (!file) {
      res.writeHead(404, { ...SECURITY_HEADERS, 'content-type': 'text/plain; charset=utf-8' });
      return res.end('Not Found');
    }
    return sendFile(req, res, file);
  };
}
