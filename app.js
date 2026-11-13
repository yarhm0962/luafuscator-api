(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LuaFuscatorCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const LUA_FILES = [
    'config.lua', 'manifest.lua', 'pipeline.lua',
    'modules/antitamper.lua', 'modules/bytecode_encoder.lua', 'modules/compressor.lua',
    'modules/control_flow_obfuscator.lua', 'modules/dynamic_code_generator.lua',
    'modules/function_inliner.lua', 'modules/garbage_code_inserter.lua',
    'modules/opaque_predicate_injector.lua', 'modules/string_encoder.lua',
    'modules/variable_renamer.lua', 'modules/watermark.lua',
    'modules/StringToExpressions.lua', 'modules/VMGenerator.lua', 'modules/WrapInFunction.lua',
    'modules/Compiler/Compiler.lua', 'modules/Compiler/Deserializer.lua',
    'modules/Compiler/Opcode.lua', 'modules/Compiler/Serializer.lua',
    'modules/Compiler/VMStrings.lua', 'modules/Compiler/bit.lua'
  ];

  const POLY = [
    'if not math.ldexp then math.ldexp = function(x, n) return x * 2 ^ n end end',
    'if not math.frexp then',
    '  math.frexp = function(x)',
    '    if x == 0 then return 0, 0 end',
    '    local exp = math.floor(math.log(math.abs(x)) / math.log(2)) + 1',
    '    local mantissa = x / 2 ^ exp',
    '    return mantissa, exp',
    '  end',
    'end'
  ].join('\n');

  const PRESETS = {
    light: ['variable_renaming', 'compressor'],
    balanced: ['variable_renaming', 'control_flow', 'string_encoding', 'opaque_predicates', 'compressor'],
    heavy: ['variable_renaming', 'control_flow', 'string_encoding', 'string_to_expressions', 'opaque_predicates', 'garbage_code', 'function_inlining', 'wrap_in_function', 'antitamper', 'dynamic_code', 'compressor'],
    maximum: ['virtual_machine', 'antitamper', 'control_flow', 'string_to_expressions', 'string_encoding', 'wrap_in_function', 'variable_renaming', 'garbage_code', 'opaque_predicates', 'function_inlining', 'dynamic_code', 'bytecode_encoding', 'compressor']
  };

  const METHODS = [
    { key: 'virtual_machine', name: 'Virtual Machine', description: 'Enable virtual machine transformation', incompatible: ['luau', 'glua'] },
    { key: 'antitamper', name: 'Anti Tamper', description: 'Enable antitamper', incompatible: [] },
    { key: 'control_flow', name: 'Control Flow', description: 'Enable control flow obfuscation', incompatible: [] },
    { key: 'string_to_expressions', name: 'String To Expressions', description: 'Enable string to expression conversion', incompatible: [] },
    { key: 'string_encoding', name: 'String Encoding', description: 'Enable string encoding', incompatible: [] },
    { key: 'wrap_in_function', name: 'Function Wrapping', description: 'Enable function wrapping', incompatible: [] },
    { key: 'variable_renaming', name: 'Variable Renaming', description: 'Enable variable renaming', incompatible: [] },
    { key: 'garbage_code', name: 'Garbage Code', description: 'Enable garbage code injection', incompatible: [] },
    { key: 'opaque_predicates', name: 'Opaque Predicates', description: 'Enable opaque predicates injection', incompatible: [] },
    { key: 'function_inlining', name: 'Function Inlining', description: 'Enable function inlining', incompatible: [] },
    { key: 'dynamic_code', name: 'Dynamic Code', description: 'Enable dynamic code generation', incompatible: [] },
    { key: 'bytecode_encoding', name: 'Bytecode Encoding', description: 'Enable bytecode encoding', incompatible: ['luau', 'glua'] },
    { key: 'compressor', name: 'Compressor', description: 'Enable compressor', incompatible: [] }
  ];

  function defaultLoader(path) {
    return fetch(path).then(function (r) {
      if (!r.ok) throw new Error('Failed to load ' + path + ' (' + r.status + ')');
      return r.text();
    });
  }

  function detectLuaSnippet() {
    return [
      'local luau_score = score_language(OBF_CODE, "luau")',
      'local glua_score = score_language(OBF_CODE, "glua")',
      'if glua_score > luau_score and glua_score >= threshold then detected = "glua"',
      'elseif luau_score > glua_score and luau_score >= threshold then detected = "luau"',
      'else detected = "lua" end'
    ].join('\n');
  }

  function isVmOutput(code) {
    return code.indexOf('hercules,v1,alpha') !== -1;
  }

  function wrapLoader(code) {
    let level = 1;
    const re = /\]=*\]/g;
    let m;
    while ((m = re.exec(code)) !== null) {
      const k = m[0].length - 2;
      if (k >= level) level = k + 1;
    }
    const open = '[' + '='.repeat(level) + '[';
    const close = ']' + '='.repeat(level) + ']';
    const shim = 'if not math.ldexp then math.ldexp=function(x,n) return x*2^n end end\n';
    return 'local __PAYLOAD=' + open + '\n' + code + '\n' + close + '\n' +
      shim +
      'local __RUN=loadstring or load\n' +
      'local __CHUNK=__RUN(__PAYLOAD,"@luafuscator")\n' +
      'if not __CHUNK then error("LuaFuscator: failed to load payload",2) end\n' +
      'return __CHUNK()';
  }

  function luauCompat(code) {
    return code.split('assert(load(').join('assert((loadstring or load)(');
  }

  function beautifyLua(code) {
    if (isVmOutput(code)) return code;
    let out = '';
    let depth = 0;
    let i = 0;
    const n = code.length;
    while (i < n) {
      const ch = code[i];
      if (ch === '-' && code[i + 1] === '-') {
        if (code[i + 2] === '[') {
          let j = i + 3;
          let eq = 0;
          while (code[j] === '=') { eq++; j++; }
          if (code[j] === '[') {
            const close = ']' + '='.repeat(eq) + ']';
            const end = code.indexOf(close, j + 1);
            const stop = end === -1 ? n : end + close.length;
            const seg = code.slice(i, stop);
            out += seg;
            if (seg.indexOf('\n') === -1) out += '\n';
            i = stop;
            continue;
          }
        }
        const end = code.indexOf('\n', i);
        const stop = end === -1 ? n : end + 1;
        out += code.slice(i, stop);
        i = stop;
        continue;
      }
      if (ch === '"' || ch === "'") {
        const q = ch;
        out += ch;
        i++;
        while (i < n) {
          const c = code[i];
          out += c;
          if (c === '\\' && i + 1 < n) { out += code[i + 1]; i += 2; continue; }
          i++;
          if (c === q) break;
        }
        continue;
      }
      if (ch === '[') {
        let j = i + 1;
        let eq = 0;
        while (code[j] === '=') { eq++; j++; }
        if (code[j] === '[') {
          const close = ']' + '='.repeat(eq) + ']';
          const end = code.indexOf(close, j + 1);
          const stop = end === -1 ? n : end + close.length;
          out += code.slice(i, stop);
          i = stop;
          continue;
        }
        depth++;
        out += ch;
        i++;
        continue;
      }
      if (ch === '(') { depth++; out += ch; i++; continue; }
      if (ch === '{') { depth++; out += ch; i++; continue; }
      if (ch === ')' || ch === ']' || ch === '}') { if (depth > 0) depth--; out += ch; i++; continue; }
      if (ch === ';' && depth === 0) {
        out += ';\n';
        i++;
        while (code[i] === ' ' || code[i] === '\t') i++;
        continue;
      }
      if (ch === '\n') {
        out += '\n';
        i++;
        while (code[i] === '\n') i++;
        continue;
      }
      out += ch;
      i++;
    }
    return out.replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '');
  }

  function Obfuscator(opts) {
    opts = opts || {};
    this.wasmUri = opts.wasmUri || null;
    this.getWasmoon = opts.getWasmoon || (typeof wasmoon !== 'undefined' ? wasmoon : null);
    this.loader = opts.loader || defaultLoader;
    this.mounted = false;
    this.factory = null;
  }

  Obfuscator.prototype.mount = function () {
    const self = this;
    if (self.factory) return Promise.resolve(self.factory);
    if (!self.getWasmoon) return Promise.reject(new Error('wasmoon is not loaded'));
    const LuaFactory = self.getWasmoon.LuaFactory;
    const factory = self.wasmUri ? new LuaFactory(self.wasmUri) : new LuaFactory();
    let p = Promise.resolve();
    LUA_FILES.forEach(function (rel) {
      p = p.then(function () {
        return Promise.resolve(self.loader(rel)).then(function (text) {
          return factory.mountFile(rel, text);
        });
      });
    });
    return p.then(function () {
      self.factory = factory;
      return factory;
    });
  };

  Obfuscator.prototype.run = function (input) {
    const self = this;
    const t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    return self.mount().then(function (factory) {
      return factory.createEngine();
    }).then(function (engine) {
      engine.doString(POLY);
      engine.global.set('OBF_CODE', input.code);
      engine.global.set('OBF_TARGET', input.target || 'auto');
      const methods = input.methods && input.methods.length ? input.methods : [];
      let all = [];
      METHODS.forEach(function (m) { all.push(m.key); });
      engine.global.set('OBF_METHODS', (methods.length ? methods : all).join(','));
      let watermark = input.watermark || '';
      if (watermark && watermark.charAt(watermark.length - 1) !== '\n') watermark += '\n';
      engine.global.set('OBF_WATERMARK', watermark);
      const RUN = [
        'local config = require("config")',
        'local manifest = require("manifest")',
        'local Pipeline = require("pipeline")',
        'local wanted = {}',
        'for k in OBF_METHODS:gmatch("[^,]+") do wanted[k] = true end',
        'local target = OBF_TARGET',
        'local detected = target',
        'local function score_language(code, language)',
        '  local detection = manifest.language_detection or {}',
        '  local language_config = ((detection.languages or {})[language] or {})',
        '  local score = 0',
        '  for _, item in ipairs(language_config.patterns or {}) do',
        '    local matched = item.lua_pattern and code:match(item.lua_pattern)',
        '    for _, pattern in ipairs(item.lua_patterns or {}) do',
        '      matched = matched or code:match(pattern)',
        '    end',
        '    if matched then score = score + (item.weight or 1) end',
        '  end',
        '  return score',
        'end',
        'local threshold = (manifest.language_detection or {}).threshold or 2',
        'if target == "auto" then',
        detectLuaSnippet(),
        'end',
        'target = detected',
        'config.target = target',
        'for _, m in ipairs(manifest.modules) do',
        '  config.settings[m.config_key].enabled = wanted[m.key] == true and not manifest.is_incompatible(m, target)',
        'end',
        'config.set("settings.watermark_text", OBF_WATERMARK)',
        'local ok, out = pcall(Pipeline.process, OBF_CODE)',
        'if not ok then return "ERR|" .. tostring(out) end',
        'return target .. "\\v" .. out'
      ].join('\n');
      return engine.doString(RUN).then(function (result) {
        engine.dispose && engine.dispose();
        const s = String(result);
        const sep = s.indexOf('\v');
        if (s.slice(0, 4) === 'ERR|') {
          return { ok: false, error: s.slice(4) };
        }
        const target = s.slice(0, sep);
        let out = s.slice(sep + 1);
        out = luauCompat(out);
        const vm = isVmOutput(out);
        const format = input.format === 'compact' ? 'compact' : 'readable';
        if (format === 'readable') out = beautifyLua(out);
        const mode = input.mode === 'loader' ? 'loader' : 'standalone';
        if (mode === 'loader') out = wrapLoader(out);
        const t1 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        return { ok: true, code: out, target: target, timeMs: Math.round(t1 - t0), inSize: input.code.length, outSize: out.length, vm: vm, mode: mode, format: format };
      }, function (err) {
        try { engine.dispose && engine.dispose(); } catch (e2) {}
        return { ok: false, error: (err && err.message) ? err.message : String(err) };
      });
    }).catch(function (e) {
      return { ok: false, error: (e && e.message) ? e.message : String(e) };
    });
  };

  return { Obfuscator: Obfuscator, LUA_FILES: LUA_FILES, METHODS: METHODS, PRESETS: PRESETS, beautifyLua: beautifyLua, wrapLoader: wrapLoader, luauCompat: luauCompat };
});
