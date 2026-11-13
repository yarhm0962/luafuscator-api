const { parentPort } = require('worker_threads');
const path = require('path');
const fs = require('fs');
const wasmoon = require('wasmoon');
const core = require('./app.js');

let obf = null;
function getObf() {
  if (!obf) {
    obf = new core.Obfuscator({
      wasmUri: path.join(__dirname, 'node_modules', 'wasmoon', 'dist', 'glue.wasm'),
      getWasmoon: wasmoon,
      loader: (p) => fs.readFileSync(path.join(__dirname, 'lua', p), 'utf8')
    });
  }
  return obf;
}

parentPort.on('message', async (job) => {
  const { jobId, input } = job;
  const t0 = Date.now();
  try {
    const r = await getObf().run(input);
    r.timeMs = Date.now() - t0;
    parentPort.postMessage({ jobId, result: r });
  } catch (e) {
    parentPort.postMessage({ jobId, result: { ok: false, error: (e && e.message) ? e.message : String(e), timeMs: Date.now() - t0 } });
  }
});
