const http = require('http');
const path = require('path');
const { Worker } = require('worker_threads');
const crypto = require('crypto');
const core = require('./app.js');

const VERSION = '1.0.0';
const PORT = parseInt(process.env.PORT || '8787', 10);
const MAX_BODY = 512 * 1024;          // raw request body cap
const MAX_CODE = 262144;              // input code cap (chars)
const SYNC_LIMIT = 16384;             // inputs at/below this return synchronously
const QUEUE_MAX = 100;
const RATE_POST = 30;                 // POSTs per window per IP
const RATE_WINDOW = 60 * 1000;
const JOB_TTL = 30 * 60 * 1000;
const POOL_SIZE = 2;

const PRESETS = { light: 1, balanced: 1, heavy: 1, maximum: 1 };
const TARGETS = { auto: 1, luau: 1, lua: 1, glua: 1 };
const FORMATS = { readable: 1, compact: 1 };
const MODES = { standalone: 1, loader: 1 };

const jobs = new Map(); // id -> {id, status, result, created, size}
const rate = new Map(); // ip -> [timestamps]

process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e && e.message ? e.message : e));
process.on('uncaughtException', (e) => console.error('[uncaughtException]', e && e.message ? e.message : e));

// ---- worker pool ----
const pool = [];
for (let i = 0; i < POOL_SIZE; i++) {
  const w = new Worker(path.join(__dirname, 'worker.js'));
  w.__busy = null;
  w.on('message', (msg) => {
    const job = w.__busy;
    w.__busy = null;
    if (job && msg.jobId === job.id) {
      job.status = msg.result && msg.result.ok ? 'done' : 'error';
      job.result = msg.result;
      if (job.waiters) job.waiters.forEach((fn) => fn());
      drain();
    } else {
      console.error('[pool] stray result', msg.jobId);
      drain();
    }
  });
  w.on('error', (e) => {
    console.error('[worker error]', e && e.message ? e.message : e);
    const job = w.__busy;
    w.__busy = null;
    if (job) {
      job.status = 'error';
      job.result = { ok: false, error: 'worker crashed: ' + (e && e.message ? e.message : 'unknown') };
      if (job.waiters) job.waiters.forEach((fn) => fn());
    }
  });
  w.on('exit', (code) => console.error('[worker exit]', code));
  pool.push(w);
}

const queue = [];
function drain() {
  while (queue.length) {
    const w = pool.find((p) => !p.__busy);
    if (!w) return;
    const job = queue.shift();
    w.__busy = job;
    job.status = 'running';
    w.postMessage({ jobId: job.id, input: job.input });
    job.input = null; // free memory
  }
}

function submit(input, sync) {
  const id = crypto.randomBytes(8).toString('hex');
  const job = { id, status: 'queued', result: null, created: Date.now(), size: input.code.length, presetName: input.presetName, input, waiters: sync ? [] : null };
  if (jobs.size > 5000) sweepJobs();
  jobs.set(id, job);
  if (queue.length >= QUEUE_MAX) {
    jobs.delete(id);
    return { err: 'rate', msg: 'Server is busy, try again shortly' };
  }
  queue.push(job);
  drain();
  return { job };
}

function sweepJobs() {
  const now = Date.now();
  for (const [id, j] of jobs) if (now - j.created > JOB_TTL && j.status !== 'running') jobs.delete(id);
  for (const [ip, arr] of rate) {
    while (arr.length && now - arr[0] > RATE_WINDOW) arr.shift();
    if (!arr.length) rate.delete(ip);
  }
}
setInterval(sweepJobs, 5 * 60 * 1000).unref();

// ---- helpers ----
function cors(res, extra) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (extra) for (const k of Object.keys(extra)) res.setHeader(k, extra[k]);
}
function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}
function ip(req) {
  const xf = req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'];
  return (xf ? String(xf).split(',')[0].trim() : req.socket.remoteAddress) || 'unknown';
}
function rateLimited(r, isPost) {
  if (!isPost) return false;
  const now = Date.now();
  let arr = rate.get(r);
  if (!arr) { arr = []; rate.set(r, arr); }
  while (arr.length && now - arr[0] > RATE_WINDOW) arr.shift();
  if (arr.length >= RATE_POST) return true;
  arr.push(now);
  return false;
}
function readBody(req, cb) {
  let size = 0; const chunks = [];
  req.on('data', (c) => { size += c.length; if (size > MAX_BODY) { req.destroy(); cb(null, 'too_large'); } else chunks.push(c); });
  req.on('end', () => cb(Buffer.concat(chunks).toString('utf8'), null));
  req.on('error', () => cb(null, 'read_error'));
}
function validate(b) {
  if (!b || typeof b !== 'object') return 'Body must be a JSON object';
  if (typeof b.code !== 'string' || !b.code.trim()) return 'Field "code" (string) is required';
  if (b.code.length > MAX_CODE) return 'Field "code" is too large (max ' + MAX_CODE + ' chars)';
  const preset = b.preset == null ? 'balanced' : String(b.preset).toLowerCase();
  if (!PRESETS[preset]) return 'Field "preset" must be one of light, balanced, heavy, maximum';
  const target = b.target == null ? 'luau' : String(b.target).toLowerCase();
  if (!TARGETS[target]) return 'Field "target" must be one of auto, luau, lua, glua';
  const format = b.format == null ? 'compact' : String(b.format).toLowerCase();
  if (!FORMATS[format]) return 'Field "format" must be readable or compact';
  const mode = b.mode == null ? 'standalone' : String(b.mode).toLowerCase();
  if (!MODES[mode]) return 'Field "mode" must be standalone or loader';
  let watermark = '';
  if (b.watermark != null) {
    if (typeof b.watermark !== 'string') return 'Field "watermark" must be a string';
    watermark = b.watermark.slice(0, 256);
  }
  return { input: { code: b.code, methods: undefined, target, format, mode, watermark, presetName: preset } };
}

const DOCS = {
  name: 'LuaFuscator API',
  version: VERSION,
  engine: 'Hercules (real, unmodified)',
  endpoints: {
    'POST /api/obfuscate': {
      body: { code: 'string (required, max 262144 chars)', preset: 'light|balanced|heavy|maximum (default balanced)', target: 'auto|luau|lua|glua (default luau)', format: 'readable|compact (default compact)', mode: 'standalone|loader (default standalone)', watermark: 'string (optional, max 256 chars)' },
      notes: 'Inputs up to 16384 chars return the result synchronously. Larger inputs return 202 with { job_id, status } - poll GET /api/obfuscate/{job_id} until done. No authentication required.'
    },
    'GET /api/obfuscate/{job_id}': 'Job status: queued|running|done|error. When done, includes the full result.',
    'GET /api/health': 'Availability check.'
  },
  example_curl: 'curl -s -X POST https://luafuscator.pages.dev/api/obfuscate -H "Content-Type: application/json" -d \'{"code":"print(\\"hi\\")","preset":"maximum","target":"luau","mode":"loader"}\''
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  try {
    if (req.method === 'OPTIONS') { cors(res); res.writeHead(204); return res.end(); }
    cors(res);
    if (p === '/api/health' && req.method === 'GET') {
      let queued = queue.length, running = pool.filter((w) => w.__busy).length;
      return send(res, 200, { ok: true, version: VERSION, uptime_s: Math.round(process.uptime()), jobs: { queued, running } });
    }
    if (p === '/' && req.method === 'GET') return send(res, 200, DOCS);
    if (p === '/api/obfuscate' && req.method === 'POST') {
      if (rateLimited(ip(req), true)) return send(res, 429, { ok: false, error: 'Rate limit: 30 requests per minute', retry_after_s: 60 });
      return readBody(req, (raw, err) => {
        if (err === 'too_large') return send(res, 413, { ok: false, error: 'Request body too large (max 512KB)' });
        if (err) return send(res, 400, { ok: false, error: 'Could not read request body' });
        let b;
        try { b = JSON.parse(raw); } catch (e) { return send(res, 400, { ok: false, error: 'Body must be valid JSON' }); }
        const v = validate(b);
        if (typeof v === 'string') return send(res, 400, { ok: false, error: v });
        const input = v.input;
        const s = submit(input, input.code.length <= SYNC_LIMIT);
        if (s.err) return send(res, 503, { ok: false, error: s.msg });
        if (s.job.waiters) {
          const done = () => {
            const r = s.job.result;
            if (r && r.ok) {
              return send(res, 200, { ok: true, target: r.target, preset: input.presetName, mode: r.mode, format: r.format, vm: r.vm, time_ms: r.timeMs, in_size: r.inSize, out_size: r.outSize, output: r.code });
            }
            send(res, 422, { ok: false, error: (r && r.error) ? r.error : 'Obfuscation failed' });
          };
          if (s.job.status === 'done' || s.job.status === 'error') return done();
          s.job.waiters.push(done);
          return;
        }
        return send(res, 202, { ok: true, job_id: s.job.id, status: s.job.status, poll: '/api/obfuscate/' + s.job.id, note: 'Large input: poll until status is done' });
      });
    }
    const m = p.match(/^\/api\/obfuscate\/([a-f0-9]{16})$/);
    if (m && req.method === 'GET') {
      const job = jobs.get(m[1]);
      if (!job) return send(res, 404, { ok: false, error: 'Unknown job id (jobs expire after 30 minutes)' });
      if (job.status === 'done' || job.status === 'error') {
        const r = job.result;
        if (r && r.ok) return send(res, 200, { ok: true, job_id: job.id, status: 'done', target: r.target, preset: job.presetName, mode: r.mode, format: r.format, vm: r.vm, time_ms: r.timeMs, in_size: r.inSize, out_size: r.outSize, output: r.code });
        return send(res, 200, { ok: false, job_id: job.id, status: 'error', error: (r && r.error) ? r.error : 'Obfuscation failed' });
      }
      return send(res, 200, { ok: true, job_id: job.id, status: job.status });
    }
    return send(res, 404, { ok: false, error: 'Not found. See GET / for API docs.' });
  } catch (e) {
    console.error('[request error]', e && e.message ? e.message : e);
    try { send(res, 500, { ok: false, error: 'Internal error' }); } catch (e2) {}
  }
});

server.listen(PORT, '0.0.0.0', () => console.log('[luafuscator-api] listening on', PORT));
