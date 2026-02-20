// deno/moonbit-runner/moonc-wasm.ts
async function loadMoonc(options) {
  const { wasmBinary, wasmModule, vfs } = options;
  const envVars = options.env ?? {};
  return {
    async run(args) {
      let stdout = "";
      let stderr = "";
      let exitCode = 0;
      const textDecoder = new TextDecoder("utf-8");
      const textEncoder = new TextEncoder();
      if ("stdout" in vfs) {
        vfs.stdout = (data) => {
          stdout += textDecoder.decode(data);
        };
      }
      if ("stderr" in vfs) {
        vfs.stderr = (data) => {
          stderr += textDecoder.decode(data);
        };
      }
      const TA_TYPES = [
        Float32Array,
        Float64Array,
        Int8Array,
        Uint8Array,
        Int16Array,
        Uint16Array,
        Int32Array,
        Int32Array,
        Int32Array,
        Int32Array,
        Float32Array,
        Float64Array,
        Uint8Array,
        Uint16Array,
        Uint8ClampedArray
      ];
      const O_FLAGS = [0, 1, 2, 8, 512, 1024, 2048];
      let camlCallback = null;
      let camlAllocTm = null;
      let camlAllocStat = null;
      let camlStartFiber = null;
      let camlExtractString = null;
      let stringGet = null;
      let stringSet = null;
      let wasmMemory = null;
      const convertStat = (s) => {
        if (!s || !camlAllocStat) return null;
        const kind = s.isFile ? 0 : s.isDirectory ? 1 : 0;
        return camlAllocStat(
          0,
          0,
          kind,
          s.mode,
          1,
          0,
          0,
          0,
          BigInt(s.size),
          s.mtime / 1e3,
          s.mtime / 1e3,
          s.mtime / 1e3
        );
      };
      const webAssemblyWithTag = WebAssembly;
      const bindings = {
        // JavaScript tag for exceptions
        jstag: webAssemblyWithTag.Tag ? new webAssemblyWithTag.Tag({
          parameters: ["externref"],
          results: []
        }) : null,
        // Basic JS operations
        identity: (a) => a,
        from_bool: (a) => !!a,
        get: (a, b) => a[b],
        set: (a, b, c) => a[b] = c,
        delete: (a, b) => delete a[b],
        instanceof: (a, b) => a instanceof b,
        typeof: (a) => typeof a,
        equals: (a, b) => a == b,
        strict_equals: (a, b) => a === b,
        fun_call: (a, b, c) => a.apply(b, c),
        meth_call: (a, b, c) => a[b].apply(a, c),
        new_array: (n) => new Array(n),
        new_obj: () => ({}),
        new: (ctor, args2) => new ctor(...args2),
        global_this: globalThis,
        iter_props: (obj, cb) => {
          for (const k in obj) if (Object.hasOwn(obj, k)) cb(k);
        },
        array_length: (a) => a.length,
        array_get: (a, i) => a[i],
        array_set: (a, i, v) => a[i] = v,
        // String operations (use WASM memory)
        read_string: (len) => {
          if (!wasmMemory) return "";
          return textDecoder.decode(wasmMemory.subarray(0, len));
        },
        read_string_stream: (len, stream) => {
          if (!wasmMemory) return "";
          return textDecoder.decode(wasmMemory.subarray(0, len), { stream });
        },
        append_string: (a, b) => a + b,
        write_string: (s) => {
          if (!wasmMemory) return 0;
          let offset = 0;
          let remaining = s.length;
          while (remaining > 0) {
            const { read, written } = textEncoder.encodeInto(
              s.slice(offset),
              wasmMemory
            );
            remaining -= read;
            if (remaining > 0) {
              camlExtractString?.(written);
              offset += read;
            } else {
              return written;
            }
          }
          return 0;
        },
        // TypedArray operations
        ta_create: (kind, len) => new TA_TYPES[kind](len),
        ta_normalize: (a) => a instanceof Uint32Array ? new Int32Array(a.buffer, a.byteOffset, a.length) : a,
        ta_kind: (b) => TA_TYPES.findIndex((T) => b instanceof T),
        ta_length: (a) => a.length,
        ta_get_f64: (a, i) => a[i],
        ta_get_f32: (a, i) => a[i],
        ta_get_i32: (a, i) => a[i],
        ta_get_i16: (a, i) => a[i],
        ta_get_ui16: (a, i) => a[i],
        ta_get_i8: (a, i) => a[i],
        ta_get_ui8: (a, i) => a[i],
        ta_get16_ui8: (a, i) => a[i] | a[i + 1] << 8,
        ta_get32_ui8: (a, i) => a[i] | a[i + 1] << 8 | a[i + 2] << 16 | a[i + 3] << 24,
        ta_set_f64: (a, i, v) => a[i] = v,
        ta_set_f32: (a, i, v) => a[i] = v,
        ta_set_i32: (a, i, v) => a[i] = v,
        ta_set_i16: (a, i, v) => a[i] = v,
        ta_set_ui16: (a, i, v) => a[i] = v,
        ta_set_i8: (a, i, v) => a[i] = v,
        ta_set_ui8: (a, i, v) => a[i] = v,
        ta_set16_ui8: (a, i, v) => {
          a[i] = v;
          a[i + 1] = v >> 8;
        },
        ta_set32_ui8: (a, i, v) => {
          a[i] = v;
          a[i + 1] = v >> 8;
          a[i + 2] = v >> 16;
          a[i + 3] = v >> 24;
        },
        ta_fill: (a, v) => a.fill(v),
        ta_blit: (src, dst) => dst.set(src),
        ta_subarray: (a, start, end) => a.subarray(start, end),
        ta_set: (a, v, o) => a.set(v, o),
        ta_new: (len) => new Uint8Array(len),
        ta_copy: (a, dst, src, end) => a.copyWithin(dst, src, end),
        ta_bytes: (a) => new Uint8Array(
          a.buffer,
          a.byteOffset,
          a.length * a.BYTES_PER_ELEMENT
        ),
        // These use WASM-exported string_get/string_set for OCaml strings
        ta_blit_from_string: (s, soff, dst, doff, len) => {
          if (stringGet) {
            for (let i = 0; i < len; i++) {
              dst[doff + i] = stringGet(s, soff + i);
            }
          }
        },
        ta_blit_to_string: (src, soff, dst, doff, len) => {
          if (stringSet) {
            for (let i = 0; i < len; i++) {
              stringSet(dst, doff + i, src[soff + i]);
            }
          }
        },
        // Callbacks
        wrap_callback: (f) => function(...a) {
          if (a.length === 0) a = [void 0];
          return camlCallback(f, a.length, a, 1);
        },
        wrap_callback_args: (f) => (...a) => camlCallback(f, 1, [a], 0),
        wrap_callback_strict: (n, f) => (...a) => {
          a.length = n;
          return camlCallback(f, n, a, 0);
        },
        wrap_callback_unsafe: (f) => (...a) => camlCallback(f, a.length, a, 2),
        wrap_meth_callback: (f) => function(...a) {
          a.unshift(this);
          return camlCallback(f, a.length, a, 1);
        },
        wrap_meth_callback_args: (f) => function(...a) {
          return camlCallback(f, 2, [this, a], 0);
        },
        wrap_meth_callback_strict: (n, f) => function(...a) {
          a.length = n;
          a.unshift(this);
          return camlCallback(f, a.length, a, 0);
        },
        wrap_meth_callback_unsafe: (f) => function(...a) {
          a.unshift(this);
          return camlCallback(f, a.length, a, 2);
        },
        wrap_fun_arguments: (f) => (...a) => f(a),
        // Formatting
        format_float: (prec, style, sign, value) => {
          let result;
          switch (style) {
            case 0:
              result = value.toExponential(prec);
              break;
            case 1:
              result = value.toFixed(prec);
              break;
            default:
              result = value.toPrecision(prec || 1);
          }
          return sign ? " " + result : result;
        },
        // Time
        gettimeofday: () => Date.now() / 1e3,
        gmtime: (t) => {
          const d = new Date(t * 1e3);
          const jan1 = new Date(Date.UTC(d.getUTCFullYear(), 0, 1)).getTime();
          const yday = Math.floor((d.getTime() - jan1) / 864e5);
          return camlAllocTm(
            d.getUTCSeconds(),
            d.getUTCMinutes(),
            d.getUTCHours(),
            d.getUTCDate(),
            d.getUTCMonth(),
            d.getUTCFullYear() - 1900,
            d.getUTCDay(),
            yday,
            false
          );
        },
        localtime: (t) => {
          const d = new Date(t * 1e3);
          const jan1 = new Date(d.getFullYear(), 0, 1).getTime();
          const yday = Math.floor((d.getTime() - jan1) / 864e5);
          return camlAllocTm(
            d.getSeconds(),
            d.getMinutes(),
            d.getHours(),
            d.getDate(),
            d.getMonth(),
            d.getFullYear() - 1900,
            d.getDay(),
            yday,
            false
          );
        },
        mktime: (y, m, d, h, min, s) => new Date(y, m, d, h, min, s).getTime(),
        random_seed: () => crypto.getRandomValues(new Int32Array(12)),
        // File system (VFS)
        open: (path, flags, mode) => {
          const f = O_FLAGS.reduce(
            (acc, flag, i) => flags & 1 << i ? acc | flag : acc,
            0
          );
          return vfs.open(path, f, mode);
        },
        close: (fd) => vfs.close(fd),
        write: (fd, buf, off, len, pos) => vfs.write(fd, buf, off, len, pos),
        read: (fd, buf, off, len, pos) => vfs.read(fd, buf, off, len, pos),
        file_size: (fd) => BigInt(vfs.fstat(fd)?.size ?? 0),
        file_exists: (path) => +vfs.exists(path),
        is_directory: (path) => +(vfs.stat(path)?.isDirectory ?? false),
        readdir: (path) => vfs.readdir(path),
        mkdir: (path, _mode) => vfs.mkdir(path),
        rmdir: (path) => vfs.rmdir(path),
        unlink: (path) => vfs.unlink(path),
        stat: (path) => convertStat(vfs.stat(path)),
        lstat: (path) => convertStat(vfs.stat(path)),
        fstat: (fd) => convertStat(vfs.fstat(fd)),
        utimes: () => {
        },
        truncate: (path, len) => {
          const data = vfs.readFile(path);
          if (data) vfs.writeFile(path, data.subarray(0, len));
        },
        ftruncate: (fd, len) => vfs.ftruncate(fd, len),
        rename: (from, to) => vfs.rename(from, to),
        // Process
        exit: (code) => {
          exitCode = code;
          throw new Error(`exit(${code})`);
        },
        argv: () => args,
        on_windows: () => 0,
        getenv: (key) => envVars[key] ?? null,
        system: () => {
          throw new Error("system() not supported");
        },
        isatty: () => 0,
        time: () => performance.now(),
        getcwd: () => vfs.cwd(),
        chdir: (path) => vfs.chdir(path),
        // Channel management
        register_channel: () => {
        },
        unregister_channel: () => {
        },
        channel_list: () => [],
        // Error handling
        throw: (e) => {
          throw e;
        },
        // Fiber (simplified)
        start_fiber: (f) => camlStartFiber?.(f),
        suspend_fiber: (f, v) => new Promise((resolve) => f(resolve, v)),
        resume_fiber: (resolve, v) => resolve(v),
        // WeakRef/Map
        weak_new: (v) => new WeakRef(v),
        weak_deref: (r) => r.deref() ?? null,
        weak_map_new: () => /* @__PURE__ */ new WeakMap(),
        map_new: () => /* @__PURE__ */ new Map(),
        map_get: (m, k) => m.get(k) ?? null,
        map_set: (m, k, v) => m.set(k, v),
        map_delete: (m, k) => m.delete(k),
        // Debug
        log: (v) => console.log(v)
      };
      const mathImports = {
        cos: Math.cos,
        sin: Math.sin,
        tan: Math.tan,
        acos: Math.acos,
        asin: Math.asin,
        atan: Math.atan,
        cosh: Math.cosh,
        sinh: Math.sinh,
        tanh: Math.tanh,
        acosh: Math.acosh,
        asinh: Math.asinh,
        atanh: Math.atanh,
        cbrt: Math.cbrt,
        exp: Math.exp,
        expm1: Math.expm1,
        log: Math.log,
        log1p: Math.log1p,
        log2: Math.log2,
        log10: Math.log10,
        atan2: Math.atan2,
        hypot: Math.hypot,
        pow: Math.pow,
        fmod: (a, b) => a % b
      };
      const hashString = (seed, s) => {
        if (typeof s !== "string") {
          console.error("hash called with non-string:", typeof s, s);
          return seed;
        }
        let h = seed;
        for (let i = 0; i < s.length; i++) {
          const c = s.charCodeAt(i);
          h = Math.imul(h, 3432918353) | 0;
          h = h << 15 | h >>> 17;
          h = Math.imul(h, 461845907);
          h ^= c;
          h = h << 13 | h >>> 19;
          h = (h + (h << 2) | 0) + 3864292196;
        }
        return h ^ s.length;
      };
      const stringBuiltins = {
        test: (a) => +(typeof a === "string"),
        compare: (a, b) => {
          if (typeof a !== "string" || typeof b !== "string") return 0;
          return a < b ? -1 : +(a > b);
        },
        hash: hashString,
        decodeStringFromUTF8Array: () => "",
        encodeStringToUTF8Array: () => 0,
        fromCharCodeArray: () => ""
      };
      const imports = {
        Math: mathImports,
        bindings,
        "wasm:js-string": stringBuiltins,
        "wasm:text-decoder": stringBuiltins,
        "wasm:text-encoder": stringBuiltins,
        env: {},
        OCaml: {}
      };
      try {
        const module = wasmModule ?? (wasmBinary !== void 0 ? await WebAssembly.compile(wasmBinary) : null);
        if (module === null) {
          throw new Error("missing moonc wasm source");
        }
        const instance = await WebAssembly.instantiate(
          module,
          imports
        );
        const exports = instance.exports;
        camlCallback = exports.caml_callback;
        camlAllocTm = exports.caml_alloc_tm;
        camlAllocStat = exports.caml_alloc_stat;
        camlStartFiber = exports.caml_start_fiber;
        camlExtractString = exports.caml_extract_string;
        stringGet = exports.string_get;
        stringSet = exports.string_set;
        if (exports.caml_buffer) {
          const buffer = exports.caml_buffer.buffer;
          wasmMemory = new Uint8Array(buffer, 0, buffer.byteLength);
        }
        await exports._initialize();
        return { exitCode, stdout, stderr };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.startsWith("exit(")) {
          exitCode = parseInt(msg.slice(5, -1));
          return { exitCode, stdout, stderr };
        }
        stderr += msg + "\n";
        return { exitCode: 1, stdout, stderr };
      }
    }
  };
}

// deno/moonbit-runner/vfs.ts
var O_APPEND = 8;
var O_CREAT = 512;
var O_TRUNC = 1024;

// deno/moonbit-runner/memory-vfs.ts
var MemoryVFS = class {
  files = /* @__PURE__ */ new Map();
  directories = /* @__PURE__ */ new Set(["/"]);
  currentDir = "/";
  openFiles = /* @__PURE__ */ new Map();
  nextFd = 10;
  // 0-2 は stdin/stdout/stderr
  // stdout/stderr のハンドラ
  stdout = () => {
  };
  stderr = () => {
  };
  constructor() {
    this.directories.add("/");
  }
  // パス正規化
  resolve(...paths) {
    let result = paths[0]?.startsWith("/") ? "" : this.currentDir;
    for (const p of paths) {
      if (p.startsWith("/")) {
        result = p;
      } else {
        result = result + "/" + p;
      }
    }
    const parts = result.split("/").filter((p) => p && p !== ".");
    const stack = [];
    for (const part of parts) {
      if (part === "..") {
        stack.pop();
      } else {
        stack.push(part);
      }
    }
    return "/" + stack.join("/");
  }
  cwd() {
    return this.currentDir;
  }
  chdir(path) {
    const resolved = this.resolve(path);
    if (!this.directories.has(resolved) && !this.files.has(resolved)) {
      throw new Error(`ENOENT: ${path}`);
    }
    this.currentDir = resolved;
  }
  // ファイル操作
  readFile(path) {
    const resolved = this.resolve(path);
    const entry = this.files.get(resolved);
    return entry?.data ?? null;
  }
  writeFile(path, data) {
    const resolved = this.resolve(path);
    const parent = resolved.substring(0, resolved.lastIndexOf("/")) || "/";
    this.mkdir(parent, true);
    this.files.set(resolved, {
      data,
      mode: 420,
      mtime: Date.now()
    });
  }
  exists(path) {
    const resolved = this.resolve(path);
    return this.files.has(resolved) || this.directories.has(resolved);
  }
  stat(path) {
    const resolved = this.resolve(path);
    const file = this.files.get(resolved);
    if (file) {
      return {
        isFile: true,
        isDirectory: false,
        size: file.data.length,
        mode: file.mode,
        mtime: file.mtime
      };
    }
    if (this.directories.has(resolved)) {
      return {
        isFile: false,
        isDirectory: true,
        size: 0,
        mode: 493,
        mtime: Date.now()
      };
    }
    return null;
  }
  // ディレクトリ操作
  readdir(path) {
    const resolved = this.resolve(path);
    const prefix = resolved === "/" ? "/" : resolved + "/";
    const entries = /* @__PURE__ */ new Set();
    for (const p of this.files.keys()) {
      if (p.startsWith(prefix)) {
        const rest = p.slice(prefix.length);
        const name = rest.split("/")[0];
        if (name) entries.add(name);
      }
    }
    for (const p of this.directories) {
      if (p.startsWith(prefix) && p !== resolved) {
        const rest = p.slice(prefix.length);
        const name = rest.split("/")[0];
        if (name) entries.add(name);
      }
    }
    return [...entries];
  }
  mkdir(path, recursive = false) {
    const resolved = this.resolve(path);
    if (recursive) {
      const parts = resolved.split("/").filter(Boolean);
      let current = "";
      for (const part of parts) {
        current += "/" + part;
        this.directories.add(current);
      }
    } else {
      this.directories.add(resolved);
    }
  }
  rmdir(path) {
    const resolved = this.resolve(path);
    this.directories.delete(resolved);
  }
  unlink(path) {
    const resolved = this.resolve(path);
    this.files.delete(resolved);
  }
  rename(from, to) {
    const resolvedFrom = this.resolve(from);
    const resolvedTo = this.resolve(to);
    const entry = this.files.get(resolvedFrom);
    if (entry) {
      this.files.set(resolvedTo, entry);
      this.files.delete(resolvedFrom);
    }
  }
  // File Descriptor API
  open(path, flags, mode) {
    const resolved = this.resolve(path);
    if (flags & O_CREAT) {
      if (!this.files.has(resolved)) {
        this.writeFile(path, new Uint8Array(0));
      }
    }
    if (flags & O_TRUNC) {
      const entry = this.files.get(resolved);
      if (entry) {
        entry.data = new Uint8Array(0);
      }
    }
    const fd = this.nextFd++;
    this.openFiles.set(fd, {
      path: resolved,
      flags,
      position: flags & O_APPEND ? this.files.get(resolved)?.data.length ?? 0 : 0
    });
    return fd;
  }
  close(fd) {
    this.openFiles.delete(fd);
  }
  read(fd, buffer, offset, length, position) {
    const openFile = this.openFiles.get(fd);
    if (!openFile) return 0;
    const entry = this.files.get(openFile.path);
    if (!entry) return 0;
    const pos = position ?? openFile.position;
    const available = Math.min(length, entry.data.length - pos);
    if (available <= 0) return 0;
    buffer.set(entry.data.subarray(pos, pos + available), offset);
    if (position === null) {
      openFile.position += available;
    }
    return available;
  }
  write(fd, buffer, offset, length, position) {
    if (fd === 1) {
      this.stdout(buffer.subarray(offset, offset + length));
      return length;
    }
    if (fd === 2) {
      this.stderr(buffer.subarray(offset, offset + length));
      return length;
    }
    const openFile = this.openFiles.get(fd);
    if (!openFile) return 0;
    let entry = this.files.get(openFile.path);
    if (!entry) {
      entry = { data: new Uint8Array(0), mode: 420, mtime: Date.now() };
      this.files.set(openFile.path, entry);
    }
    const pos = position ?? openFile.position;
    const newLength = Math.max(entry.data.length, pos + length);
    if (newLength > entry.data.length) {
      const newData = new Uint8Array(newLength);
      newData.set(entry.data);
      entry.data = newData;
    }
    entry.data.set(buffer.subarray(offset, offset + length), pos);
    entry.mtime = Date.now();
    if (position === null) {
      openFile.position += length;
    }
    return length;
  }
  fstat(fd) {
    const openFile = this.openFiles.get(fd);
    if (!openFile) return null;
    return this.stat(openFile.path);
  }
  ftruncate(fd, length) {
    const openFile = this.openFiles.get(fd);
    if (!openFile) return;
    const entry = this.files.get(openFile.path);
    if (!entry) return;
    if (length < entry.data.length) {
      entry.data = entry.data.subarray(0, length);
    } else if (length > entry.data.length) {
      const newData = new Uint8Array(length);
      newData.set(entry.data);
      entry.data = newData;
    }
  }
};

// deno/moonbit-runner/stdlib.ts
var DEFAULT_ABORT_CORE_BASE64 = "TUNPUkUyNDAxMjOElaa+AAAAuAAAACUAAACBAAAAfJDQoJIIAAAkAJCgNm1vb25iaXRsYW5nL2NvcmUvYWJvcnQlYWJvcnTAoLCiQSNtc2eVTKACAAwAEAIADAATQAgAABASoNKiQQQHBAaggEBAoAIADQAKAgANAA1AxEZAkpCRo0AhVKACAA4AAgIADgAOBAagAgANAAICAA4ADkCgAgALAAACAA8AAUBAoJDABAcECECgAgAMAAcCAAwACEBBQAQFsAQdKWFib3J0Lm1idE9AgICABB4=";
function installStdlib(vfs, stdlib) {
  for (const [path, data] of stdlib.miFiles) {
    const normalizedPath = path.startsWith("/") ? path : "/" + path;
    const miPath = normalizedPath.replace(":", "/") + ".mi";
    const dir = miPath.substring(0, miPath.lastIndexOf("/"));
    if (dir) {
      vfs.mkdir(dir, true);
    }
    vfs.writeFile(miPath, data);
  }
  vfs.mkdir("/lib/core", true);
  vfs.writeFile("/lib/core/core.core", stdlib.coreCore);
  vfs.writeFile("/lib/core/abort.core", stdlib.abortCore);
}
function getStdlibArgs(stdlib) {
  const args = [];
  args.push("-std-path", "/lib/core");
  for (const [path] of stdlib.miFiles) {
    const normalizedPath = path.startsWith("/") ? path : "/" + path;
    args.push("-i", normalizedPath.replace(":", "/") + ".mi");
  }
  return args;
}
function base64ToUint8Array(base64) {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}
function parseStdlibJson(json) {
  const miFiles = Object.entries(json.miFiles).map(
    ([path, base64]) => [path, base64ToUint8Array(base64)]
  );
  const coreCore = base64ToUint8Array(json.coreCore);
  const abortCore = base64ToUint8Array(
    json.abortCore ?? DEFAULT_ABORT_CORE_BASE64
  );
  return { miFiles, coreCore, abortCore };
}

// deno/moonbit-runner/mod.ts
var MOONC_WASM_FILENAME = "moonc.wasm";
var STDLIB_FILENAMES = {
  js: "stdlib-js.json",
  wasm: "stdlib-wasm.json",
  "wasm-gc": "stdlib-wasm-gc.json"
};
var DEFAULT_ASSET_BASE_URL = "https://raw.githubusercontent.com/mizchi/agent-cluster/main/deno/moonbit-runner/assets";
var wasmBinaryPromise = null;
var stdlibPromiseMap = {};
function precompiledMooncModule() {
  const value = globalThis.__moonbit_runner_moonc_module;
  return value instanceof WebAssembly.Module ? value : null;
}
async function resolveMooncLoadOptions() {
  const wasmModule = precompiledMooncModule();
  if (wasmModule !== null) {
    return { wasmModule };
  }
  return { wasmBinary: await getWasmBinary() };
}
function jsonResponse(body, status = 200) {
  return Response.json(body, { status });
}
function isObjectRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function normalizeTarget(raw) {
  return raw === "wasm" || raw === "wasm-gc" ? raw : "js";
}
function normalizeRunnerMode(raw) {
  if (raw === "moon-test-compat") return "moon-test-compat";
  if (raw === "wasm-gc-first") return "wasm-gc-first";
  return "simple";
}
function normalizeSourcePath(filename) {
  if (filename.startsWith("/")) {
    return filename;
  }
  return `/src/${filename}`;
}
function normalizeLibrarySourcePath(baseDir, filename) {
  const relative = filename.startsWith("/") ? filename.slice(1) : filename;
  return `${baseDir}/${relative}`;
}
function normalizeLibrarySourceDir(packageName) {
  const safe = packageName.split("/").filter((part) => part.length > 0).map((part) => part.replace(/[^a-zA-Z0-9_-]/g, "_")).join("/");
  return `/libs/${safe.length > 0 ? safe : "pkg"}`;
}
function isValidRelativePath(path) {
  if (path.length === 0 || path.startsWith("/")) return false;
  const parts = path.split("/");
  return parts.every(
    (part) => part.length > 0 && part !== "." && part !== ".."
  );
}
function basename(path) {
  const idx = path.lastIndexOf("/");
  return idx >= 0 ? path.slice(idx + 1) : path;
}
function isMoonPkgPath(path) {
  const name = basename(path);
  return name === "moon.pkg" || name === "moon.pkg.json";
}
function extractMoonPkgImportEntries(source) {
  const entries = [];
  const seen = /* @__PURE__ */ new Set();
  const blockPattern = /import(?:\s+"[^"\n]+")?\s*\{([\s\S]*?)\}/g;
  while (true) {
    const blockMatch = blockPattern.exec(source);
    if (!blockMatch) break;
    const block = blockMatch[1] ?? "";
    const entryPattern = /"([^"]+)"(?:\s+as\s+@([a-zA-Z0-9_]+))?/g;
    while (true) {
      const entryMatch = entryPattern.exec(block);
      if (!entryMatch) break;
      const packageName = entryMatch[1]?.trim() ?? "";
      const alias = entryMatch[2];
      if (packageName.length === 0) continue;
      const key = `${packageName}\0${alias ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push(alias ? { packageName, alias } : { packageName });
    }
  }
  return entries;
}
function extractMoonPkgJsonImportEntries(source) {
  const raw = parseJson(source, {});
  if (!isObjectRecord(raw)) return [];
  const value = raw.import;
  if (!Array.isArray(value)) return [];
  const entries = [];
  const seen = /* @__PURE__ */ new Set();
  for (const item of value) {
    if (typeof item !== "string") continue;
    if (seen.has(item)) continue;
    seen.add(item);
    entries.push({ packageName: item });
  }
  return entries;
}
function extractSourcePackageRefEntries(source) {
  const refs = [];
  const seen = /* @__PURE__ */ new Set();
  const matches = source.matchAll(/@([a-zA-Z0-9_/-]+)\./g);
  for (const match of matches) {
    const packageName = match[1];
    if (!packageName || seen.has(packageName)) continue;
    seen.add(packageName);
    refs.push({ packageName });
  }
  return refs;
}
function collectLibraryImports(library) {
  const imports = [];
  const seen = /* @__PURE__ */ new Set();
  for (const file of library.files) {
    let discovered = [];
    if (isMoonPkgPath(file.path)) {
      discovered = file.path.endsWith(".json") ? extractMoonPkgJsonImportEntries(file.source) : extractMoonPkgImportEntries(file.source);
    } else if (file.path.endsWith(".mbt")) {
      discovered = extractSourcePackageRefEntries(file.source);
    }
    for (const dep of discovered) {
      if (dep.packageName === library.packageName) continue;
      const key = `${dep.packageName}\0${dep.alias ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      imports.push(dep);
    }
  }
  return imports;
}
function collectLibraryDependencyNames(library) {
  const names = [];
  const seen = /* @__PURE__ */ new Set();
  for (const dep of collectLibraryImports(library)) {
    if (seen.has(dep.packageName)) continue;
    seen.add(dep.packageName);
    names.push(dep.packageName);
  }
  return names;
}
function sortLibrariesByDependencies(libraries) {
  const byName = /* @__PURE__ */ new Map();
  for (const library of libraries) {
    if (byName.has(library.packageName)) {
      throw new Error(`duplicate library package: ${library.packageName}`);
    }
    byName.set(library.packageName, library);
  }
  const depsByName = /* @__PURE__ */ new Map();
  for (const library of libraries) {
    const deps = collectLibraryDependencyNames(library).filter((dep) => byName.has(dep));
    depsByName.set(library.packageName, deps);
  }
  const visiting = /* @__PURE__ */ new Set();
  const visited = /* @__PURE__ */ new Set();
  const ordered = [];
  const visit = (name, trail) => {
    if (visited.has(name)) return;
    if (visiting.has(name)) {
      const cycle = [...trail, name].join(" -> ");
      throw new Error(`library dependency cycle detected: ${cycle}`);
    }
    visiting.add(name);
    for (const dep of depsByName.get(name) ?? []) {
      visit(dep, [...trail, name]);
    }
    visiting.delete(name);
    visited.add(name);
    const library = byName.get(name);
    if (library) {
      ordered.push(library);
    }
  };
  for (const library of libraries) {
    visit(library.packageName, []);
  }
  return ordered;
}
function isValidAliasName(alias) {
  if (alias.length === 0) return false;
  return /^[a-zA-Z0-9_]+$/.test(alias);
}
function isValidPackageName(packageName) {
  return !(packageName.length === 0 || packageName.includes("..") || packageName.startsWith("/") || packageName.endsWith("/") || packageName.includes("//"));
}
function normalizeArchivePath(path) {
  const normalized = path.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(
    (part) => part.length > 0 && part !== "."
  );
  if (parts.some((part) => part === "..")) {
    throw new Error(`invalid archive path: ${path}`);
  }
  return parts.join("/");
}
function parseTarOctal(bytes) {
  const raw = new TextDecoder().decode(bytes).replace(/\0.*$/g, "").trim();
  if (raw.length === 0) return 0;
  return Number.parseInt(raw, 8);
}
function isAllZeroBlock(block) {
  for (let i = 0; i < block.length; i++) {
    if (block[i] !== 0) return false;
  }
  return true;
}
function parseTarEntries(tarBytes) {
  const entries = [];
  const decoder = new TextDecoder();
  let offset = 0;
  while (offset + 512 <= tarBytes.length) {
    const header = tarBytes.subarray(offset, offset + 512);
    if (isAllZeroBlock(header)) {
      break;
    }
    const name = decoder.decode(header.subarray(0, 100)).replace(/\0.*$/g, "");
    const prefix = decoder.decode(header.subarray(345, 500)).replace(
      /\0.*$/g,
      ""
    );
    const fullPath = normalizeArchivePath(
      prefix.length > 0 ? `${prefix}/${name}` : name
    );
    const size = parseTarOctal(header.subarray(124, 136));
    const typeFlag = header[156];
    if (!Number.isFinite(size) || size < 0) {
      throw new Error(`invalid tar entry size: ${fullPath}`);
    }
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > tarBytes.length) {
      throw new Error(`truncated tar entry: ${fullPath}`);
    }
    if (typeFlag === 0 || typeFlag === 48) {
      const data = tarBytes.slice(dataStart, dataEnd);
      entries.push({ path: fullPath, data });
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return entries;
}
function parseAliasListText(text) {
  const aliases = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  const unique = [...new Set(aliases)];
  for (const alias of unique) {
    if (!isValidAliasName(alias)) {
      throw new Error(`invalid alias in aliases.txt: ${alias}`);
    }
  }
  return unique;
}
function parseAliasListJson(text) {
  const raw = parseJson(text, []);
  if (!Array.isArray(raw)) {
    throw new Error("aliases.json must be string array");
  }
  const aliases = raw.map((item, index) => {
    if (typeof item !== "string" || !isValidAliasName(item)) {
      throw new Error(`aliases.json[${index}] must match [a-zA-Z0-9_]+`);
    }
    return item;
  });
  return [...new Set(aliases)];
}
function parsePrebuiltPackagesTar(raw) {
  if (raw === void 0) {
    return [];
  }
  if (typeof raw !== "string" || raw.length === 0) {
    throw new Error("prebuiltPackagesTarBase64 must be non-empty string");
  }
  let tarBytes;
  try {
    tarBytes = base64ToUint8Array(raw);
  } catch {
    throw new Error("prebuiltPackagesTarBase64 is not valid base64");
  }
  const entries = parseTarEntries(tarBytes);
  const entryByPath = new Map(entries.map((entry) => [entry.path, entry.data]));
  const manifestPath = entryByPath.has("prebuilt-packages.json") ? "prebuilt-packages.json" : entryByPath.has("prebuilt_packages.json") ? "prebuilt_packages.json" : null;
  if (manifestPath) {
    const manifestRaw = parseJson(
      new TextDecoder().decode(entryByPath.get(manifestPath)),
      {}
    );
    if (!isObjectRecord(manifestRaw) || !Array.isArray(manifestRaw.packages)) {
      throw new Error(`${manifestPath} must contain { packages: [...] }`);
    }
    return manifestRaw.packages.map((item, index) => {
      if (!isObjectRecord(item)) {
        throw new Error(`${manifestPath}.packages[${index}] must be object`);
      }
      if (typeof item.packageName !== "string" || !isValidPackageName(item.packageName)) {
        throw new Error(
          `${manifestPath}.packages[${index}].packageName is invalid`
        );
      }
      const miRef = typeof item.miPath === "string" ? item.miPath : typeof item.mi === "string" ? item.mi : null;
      const coreRef = typeof item.corePath === "string" ? item.corePath : typeof item.core === "string" ? item.core : null;
      if (!miRef || !coreRef) {
        throw new Error(
          `${manifestPath}.packages[${index}] requires miPath/corePath`
        );
      }
      const miPath = normalizeArchivePath(miRef);
      const corePath = normalizeArchivePath(coreRef);
      const mi = entryByPath.get(miPath);
      const core = entryByPath.get(corePath);
      if (!mi || !core) {
        throw new Error(
          `${manifestPath}.packages[${index}] points to missing file`
        );
      }
      let aliases = [];
      if (item.aliases !== void 0) {
        if (!Array.isArray(item.aliases)) {
          throw new Error(
            `${manifestPath}.packages[${index}].aliases must be array`
          );
        }
        aliases = item.aliases.map((alias, aliasIndex) => {
          if (typeof alias !== "string" || !isValidAliasName(alias)) {
            throw new Error(
              `${manifestPath}.packages[${index}].aliases[${aliasIndex}] must match [a-zA-Z0-9_]+`
            );
          }
          return alias;
        });
        aliases = [...new Set(aliases)];
      }
      return {
        packageName: item.packageName,
        miBase64: toBase64(mi),
        coreBase64: toBase64(core),
        aliases
      };
    });
  }
  const discovered = /* @__PURE__ */ new Map();
  for (const entry of entries) {
    const match = /^packages\/(.+)\/pkg\.(mi|core)$/.exec(entry.path);
    if (match) {
      const packageName = match[1];
      if (!isValidPackageName(packageName)) {
        throw new Error(`invalid package path in tar: ${entry.path}`);
      }
      const slot = discovered.get(packageName) ?? {};
      if (match[2] === "mi") {
        slot.mi = entry.data;
      } else {
        slot.core = entry.data;
      }
      discovered.set(packageName, slot);
      continue;
    }
    const txtAliasMatch = /^packages\/(.+)\/aliases\.txt$/.exec(entry.path);
    if (txtAliasMatch) {
      const packageName = txtAliasMatch[1];
      if (!isValidPackageName(packageName)) {
        throw new Error(`invalid package path in tar: ${entry.path}`);
      }
      const slot = discovered.get(packageName) ?? {};
      slot.aliases = parseAliasListText(new TextDecoder().decode(entry.data));
      discovered.set(packageName, slot);
      continue;
    }
    const jsonAliasMatch = /^packages\/(.+)\/aliases\.json$/.exec(entry.path);
    if (jsonAliasMatch) {
      const packageName = jsonAliasMatch[1];
      if (!isValidPackageName(packageName)) {
        throw new Error(`invalid package path in tar: ${entry.path}`);
      }
      const slot = discovered.get(packageName) ?? {};
      slot.aliases = parseAliasListJson(new TextDecoder().decode(entry.data));
      discovered.set(packageName, slot);
    }
  }
  if (discovered.size === 0) {
    throw new Error(
      "prebuiltPackagesTarBase64 does not contain prebuilt packages; add prebuilt-packages.json or packages/<pkg>/pkg.{mi,core}"
    );
  }
  const result = [];
  for (const [packageName, slot] of discovered.entries()) {
    if (!slot.mi || !slot.core) {
      throw new Error(
        `prebuilt tar package ${packageName} requires both pkg.mi and pkg.core`
      );
    }
    result.push({
      packageName,
      miBase64: toBase64(slot.mi),
      coreBase64: toBase64(slot.core),
      aliases: slot.aliases ?? []
    });
  }
  return result;
}
function mergePrebuiltPackages(...groups) {
  const merged = [];
  const seen = /* @__PURE__ */ new Set();
  for (const group of groups) {
    for (const pkg of group) {
      if (seen.has(pkg.packageName)) {
        throw new Error(`duplicate prebuilt package: ${pkg.packageName}`);
      }
      seen.add(pkg.packageName);
      merged.push(pkg);
    }
  }
  return merged;
}
function buildDependencyMiArgs(imports, localArtifacts, prebuiltArtifacts) {
  const byPackage = /* @__PURE__ */ new Map();
  for (const entry of imports) {
    const set = byPackage.get(entry.packageName) ?? /* @__PURE__ */ new Set();
    set.add(entry.alias ?? "");
    byPackage.set(entry.packageName, set);
  }
  const args = [];
  for (const artifact of localArtifacts) {
    const aliases = byPackage.get(artifact.packageName);
    if (!aliases || aliases.size === 0) {
      args.push("-i", artifact.miPath);
      continue;
    }
    for (const alias of aliases) {
      args.push(
        "-i",
        alias.length > 0 ? `${artifact.miPath}:${alias}` : artifact.miPath
      );
    }
  }
  for (const artifact of prebuiltArtifacts) {
    const importAliases = byPackage.get(artifact.packageName);
    if (importAliases && importAliases.size > 0) {
      for (const alias of importAliases) {
        args.push(
          "-i",
          alias.length > 0 ? `${artifact.miPath}:${alias}` : artifact.miPath
        );
      }
      continue;
    }
    args.push("-i", artifact.miPath);
    for (const alias of artifact.aliases) {
      args.push("-i", `${artifact.miPath}:${alias}`);
    }
  }
  return args;
}
function preparePrebuiltPackages(vfs, packages) {
  const artifacts = [];
  const seenPackageNames = /* @__PURE__ */ new Set();
  for (const [index, pkg] of packages.entries()) {
    if (seenPackageNames.has(pkg.packageName)) {
      return {
        success: false,
        message: `duplicate prebuilt package: ${pkg.packageName}`
      };
    }
    seenPackageNames.add(pkg.packageName);
    const safe = pkg.packageName.split("/").filter((part) => part.length > 0).map((part) => part.replace(/[^a-zA-Z0-9_-]/g, "_")).join("/");
    const baseDir = `/prebuilt/${safe.length > 0 ? safe : `pkg_${index}`}`;
    const miPath = `${baseDir}/pkg.mi`;
    const corePath = `${baseDir}/pkg.core`;
    vfs.mkdir(baseDir, true);
    let mi;
    let core;
    try {
      mi = base64ToUint8Array(pkg.miBase64);
      core = base64ToUint8Array(pkg.coreBase64);
    } catch {
      return {
        success: false,
        message: `prebuiltPackages[${index}] has invalid base64`
      };
    }
    vfs.writeFile(miPath, mi);
    vfs.writeFile(corePath, core);
    artifacts.push({
      packageName: pkg.packageName,
      miPath,
      corePath,
      aliases: pkg.aliases
    });
  }
  return {
    success: true,
    artifacts
  };
}
function dirname(path) {
  const idx = path.lastIndexOf("/");
  if (idx <= 0) return "/";
  return path.slice(0, idx);
}
function toBase64(data) {
  let binary = "";
  for (let i = 0; i < data.length; i++) {
    binary += String.fromCharCode(data[i]);
  }
  return btoa(binary);
}
function moonStringLiteral(value) {
  const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t");
  return `"${escaped}"`;
}
function parseJson(text, fallback) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}
function normalizeAssetBaseUrl(raw) {
  if (typeof raw !== "string") return "";
  const value = raw.trim();
  if (value.length === 0) return "";
  return value.replace(/\/+$/g, "");
}
function assetBaseUrl() {
  const globalBase = normalizeAssetBaseUrl(
    globalThis.__moonbit_runner_asset_base_url
  );
  if (globalBase.length > 0) return globalBase;
  return DEFAULT_ASSET_BASE_URL;
}
function localAssetUrl(filename) {
  try {
    return new URL(`./assets/${filename}`, import.meta.url);
  } catch {
    return null;
  }
}
function remoteAssetUrl(filename) {
  return `${assetBaseUrl()}/${filename}`;
}
async function readAssetBytes(filename) {
  const local = localAssetUrl(filename);
  if (local) {
    const denoObj = globalThis.Deno;
    if (local.protocol === "file:") {
      try {
        if (typeof denoObj?.readFile === "function") {
          return await denoObj.readFile(local);
        }
      } catch {
      }
    }
    try {
      const res2 = await fetch(local);
      if (res2.ok) {
        return new Uint8Array(await res2.arrayBuffer());
      }
    } catch {
    }
  }
  const remote = remoteAssetUrl(filename);
  const res = await fetch(remote);
  if (!res.ok) {
    throw new Error(
      `failed to fetch moonbit asset: ${filename} status=${res.status}`
    );
  }
  return new Uint8Array(await res.arrayBuffer());
}
async function readAssetText(filename) {
  const bytes = await readAssetBytes(filename);
  return new TextDecoder().decode(bytes);
}
async function getWasmBinary() {
  if (wasmBinaryPromise === null) {
    wasmBinaryPromise = (async () => {
      const bytes = await readAssetBytes(MOONC_WASM_FILENAME);
      const copy = new Uint8Array(bytes.byteLength);
      copy.set(bytes);
      return copy.buffer;
    })();
  }
  return wasmBinaryPromise;
}
async function getStdlib(target) {
  const cached = stdlibPromiseMap[target];
  if (cached) {
    return cached;
  }
  const promise = (async () => {
    const jsonText = await readAssetText(STDLIB_FILENAMES[target]);
    const raw = parseJson(jsonText, {
      miFiles: {},
      coreCore: ""
    });
    return parseStdlibJson(raw);
  })();
  stdlibPromiseMap[target] = promise;
  return promise;
}
function extractCompatTestSection(raw, key, kind) {
  if (!isObjectRecord(raw)) return [];
  const section = raw[key];
  if (!isObjectRecord(section)) return [];
  const tests = [];
  for (const [filename, value] of Object.entries(section)) {
    if (!Array.isArray(value)) continue;
    for (const test of value) {
      if (!isObjectRecord(test)) continue;
      if (typeof test.index === "number" && typeof test.func === "string" && typeof test.name === "string") {
        tests.push({
          filename,
          index: test.index,
          func: test.func,
          name: test.name,
          kind
        });
      }
    }
  }
  return tests;
}
function parseTestInfo(raw) {
  return {
    noArgs: extractCompatTestSection(raw, "no_args_tests", "no_args"),
    withArgs: extractCompatTestSection(raw, "with_args_tests", "with_args"),
    asyncNoArgs: extractCompatTestSection(raw, "async_tests", "async"),
    asyncWithArgs: extractCompatTestSection(
      raw,
      "async_tests_with_args",
      "async_with_args"
    )
  };
}
function flattenCompatTests(info) {
  return [
    ...info.noArgs,
    ...info.withArgs,
    ...info.asyncNoArgs,
    ...info.asyncWithArgs
  ];
}
function extractNoArgsTests(info) {
  return info.noArgs.map((test) => ({
    index: test.index,
    func: test.func,
    name: test.name
  }));
}
function generateTestDriver(tests) {
  if (tests.length === 0) {
    return `fn main { () }`;
  }
  const calls = tests.map((test) => {
    const nameLiteral = moonStringLiteral(test.name);
    return `
  try {
    ${test.func}()
    results.push("PASS:" + ${nameLiteral})
  } catch {
    e => results.push("FAIL:" + ${nameLiteral} + ":" + e.to_string())
  }`;
  }).join("\n");
  return `
#test_entry
fn main {
  let results : Array[String] = []
${calls}
  println("---TEST_RESULTS_START---")
  for r in results { println(r) }
  println("---TEST_RESULTS_END---")
}`;
}
function generateMoonCompatTestDriver(tests) {
  const dispatch = tests.map((test, slot) => {
    const filenameLiteral = moonStringLiteral(test.filename);
    const nameLiteral = moonStringLiteral(test.name);
    const unsupportedMessage = moonStringLiteral(
      "async tests are not supported in moon-test-compat mode"
    );
    if (test.kind === "no_args") {
      return `
    if slot == ${slot} {
      try {
        ${test.func}()
        moonbit_test_driver_internal_handle_result(${filenameLiteral}, ${test.index}, ${nameLiteral}, "", false)
      } catch {
        e => moonbit_test_driver_internal_handle_result(${filenameLiteral}, ${test.index}, ${nameLiteral}, e.to_string(), false)
      }
      return
    }`;
    }
    if (test.kind === "with_args") {
      return `
    if slot == ${slot} {
      try {
        ${test.func}(@test.Test::new(${nameLiteral}))
        moonbit_test_driver_internal_handle_result(${filenameLiteral}, ${test.index}, ${nameLiteral}, "", false)
      } catch {
        e => moonbit_test_driver_internal_handle_result(${filenameLiteral}, ${test.index}, ${nameLiteral}, e.to_string(), false)
      }
      return
    }`;
    }
    return `
    if slot == ${slot} {
      moonbit_test_driver_internal_handle_result(${filenameLiteral}, ${test.index}, ${nameLiteral}, ${unsupportedMessage}, false)
      return
    }`;
  }).join("\n");
  return `
fn moonbit_test_driver_internal_handle_result(
  filename : String,
  index : Int,
  testname : String,
  message : String,
  _skipped : Bool,
) -> Unit {
  let file_name = filename.escape()
  let test_name = testname.escape()
  let message = message.escape()
  println("----- BEGIN MOON TEST RESULT -----")
  println(
    "{\\"package\\": \\"main\\", \\"filename\\": \\{file_name}, \\"index\\": \\"\\{index}\\", \\"test_name\\": \\{test_name}, \\"message\\": \\{message}}",
  )
  println("----- END MOON TEST RESULT -----")
}

#test_entry
fn main {
  ()
}

pub fn moonbit_test_driver_internal_execute(
  slot : Int,
) -> Unit {
${dispatch}
  moonbit_test_driver_internal_handle_result("", slot, "", "skipped test", true)
}

pub fn moonbit_test_driver_finish() -> Unit {
  ()
}
`;
}
function generateWasmGcFirstTestDriver(tests) {
  const dispatch = tests.map((test, slot) => {
    const filenameLiteral = moonStringLiteral(test.filename);
    const nameLiteral = moonStringLiteral(test.name);
    const unsupportedMessage = moonStringLiteral(
      "async tests are not supported in wasm-gc-first mode"
    );
    if (test.kind === "no_args") {
      return `
  if slot == ${slot} {
  try {
    ${test.func}()
    moonbit_test_driver_internal_handle_result(${filenameLiteral}, ${test.index}, ${nameLiteral}, "", false)
  } catch {
    e => moonbit_test_driver_internal_handle_result(${filenameLiteral}, ${test.index}, ${nameLiteral}, e.to_string(), false)
  }
    return
  }`;
    }
    if (test.kind === "with_args") {
      return `
  if slot == ${slot} {
  try {
    ${test.func}(@test.Test::new(${nameLiteral}))
    moonbit_test_driver_internal_handle_result(${filenameLiteral}, ${test.index}, ${nameLiteral}, "", false)
  } catch {
    e => moonbit_test_driver_internal_handle_result(${filenameLiteral}, ${test.index}, ${nameLiteral}, e.to_string(), false)
  }
    return
  }`;
    }
    return `
  if slot == ${slot} {
    moonbit_test_driver_internal_handle_result(${filenameLiteral}, ${test.index}, ${nameLiteral}, ${unsupportedMessage}, false)
    return
  }`;
  }).join("\n");
  return `
fn moonbit_test_driver_internal_handle_result(
  filename : String,
  index : Int,
  testname : String,
  message : String,
  _skipped : Bool,
) -> Unit {
  let file_name = filename.escape()
  let test_name = testname.escape()
  let message = message.escape()
  println("----- BEGIN MOON TEST RESULT -----")
  println(
    "{\\"package\\": \\"main\\", \\"filename\\": \\{file_name}, \\"index\\": \\"\\{index}\\", \\"test_name\\": \\{test_name}, \\"message\\": \\{message}}",
  )
  println("----- END MOON TEST RESULT -----")
}

#test_entry
fn main {
  ()
}

pub fn moonbit_test_driver_internal_execute(slot : Int) -> Unit {
${dispatch}
  moonbit_test_driver_internal_handle_result("", slot, "", "skipped test", true)
}

pub fn moonbit_test_driver_finish() -> Unit {
  ()
}
`;
}
function parseTestRunOutput(output) {
  const match = /---TEST_RESULTS_START---\n([\s\S]*?)---TEST_RESULTS_END---/m.exec(output);
  if (!match) {
    return [];
  }
  const lines = match[1].split("\n").map((line) => line.trim()).filter(Boolean);
  const results = [];
  for (const line of lines) {
    if (line.startsWith("PASS:")) {
      results.push({
        name: line.slice(5),
        passed: true
      });
      continue;
    }
    if (line.startsWith("FAIL:")) {
      const payload = line.slice(5);
      const sep = payload.indexOf(":");
      if (sep < 0) {
        results.push({
          name: payload,
          passed: false,
          error: "test failed"
        });
      } else {
        results.push({
          name: payload.slice(0, sep),
          passed: false,
          error: payload.slice(sep + 1)
        });
      }
    }
  }
  return results;
}
function parseMoonTestResultRows(output) {
  const rows = [];
  const pattern = /----- BEGIN MOON TEST RESULT -----\n([\s\S]*?)\n----- END MOON TEST RESULT -----/g;
  while (true) {
    const match = pattern.exec(output);
    if (!match) break;
    const payload = parseJson(match[1].trim(), {});
    if (!isObjectRecord(payload)) continue;
    if (typeof payload.filename !== "string" || typeof payload.test_name !== "string" || typeof payload.message !== "string") {
      continue;
    }
    const rawIndex = payload.index;
    const index = typeof rawIndex === "number" ? rawIndex : typeof rawIndex === "string" ? Number.parseInt(rawIndex, 10) : Number.NaN;
    if (!Number.isFinite(index)) continue;
    rows.push({
      filename: payload.filename,
      index,
      testName: payload.test_name,
      message: payload.message
    });
  }
  return rows;
}
function normalizeRuntimeFailure(runtimeError) {
  if (runtimeError === void 0) {
    return void 0;
  }
  return runtimeError.length > 0 ? runtimeError : "runtime error";
}
function extractWasmChecks(source) {
  const matches = source.matchAll(/\bfn\s+(check_[a-z0-9_]+)\s*\(/g);
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  for (const match of matches) {
    const func = match[1];
    if (!func || seen.has(func)) continue;
    seen.add(func);
    out.push({
      func,
      name: func.slice("check_".length) || func
    });
  }
  return out;
}
function generateWasmCheckDriver(checks) {
  if (checks.length === 0) {
    return `fn main { () }`;
  }
  const calls = checks.map((check) => {
    const nameLiteral = moonStringLiteral(check.name);
    return `
  if ${check.func}() {
    println("PASS:" + ${nameLiteral})
  } else {
    println("FAIL:" + ${nameLiteral})
  }`;
  }).join("\n");
  return `
fn main {
  println("---TEST_RESULTS_START---")
${calls}
  println("---TEST_RESULTS_END---")
}`;
}
function buildWasmImports(chars, importDefs) {
  const modules = {};
  const ensureModule = (moduleName) => {
    if (!modules[moduleName]) {
      modules[moduleName] = {};
    }
    return modules[moduleName];
  };
  const webAssemblyWithTag = WebAssembly;
  for (const importDef of importDefs) {
    const importMeta = importDef;
    if (importMeta.kind === "function" && importMeta.module === "spectest" && importMeta.name === "print_char") {
      const spectest = ensureModule("spectest");
      spectest.print_char = (c) => {
        chars.push(c & 255);
      };
      continue;
    }
    if (importMeta.kind === "tag" && importMeta.module === "exception" && importMeta.name === "tag") {
      if (!webAssemblyWithTag?.Tag) {
        return {
          imports: {},
          error: "WebAssembly.Tag is not available in this runtime"
        };
      }
      const exception = ensureModule("exception");
      exception.tag = new webAssemblyWithTag.Tag({
        parameters: [],
        results: []
      });
      continue;
    }
    if (importMeta.kind === "function" && importMeta.module === "exception" && importMeta.name === "throw") {
      const exception = ensureModule("exception");
      exception.throw = (...payload) => {
        if (!webAssemblyWithTag.Exception) {
          throw new Error(
            "WebAssembly.Exception is not available in this runtime"
          );
        }
        const tag = exception.tag;
        if (!tag) {
          throw new Error("exception.tag is not initialized");
        }
        throw new webAssemblyWithTag.Exception(tag, payload);
      };
      continue;
    }
    return {
      imports: {},
      error: `unsupported wasm import: ${importMeta.module}.${importMeta.name}:${importMeta.kind}`
    };
  }
  return {
    imports: modules
  };
}
async function runGeneratedWasm(wasmCode, run) {
  const chars = [];
  try {
    const wasmBytes = new Uint8Array(wasmCode.byteLength);
    wasmBytes.set(wasmCode);
    const module = await WebAssembly.compile(wasmBytes);
    const importDefs = WebAssembly.Module.imports(module);
    const importBuild = buildWasmImports(chars, importDefs);
    if (importBuild.error) {
      return { output: "", runtimeError: importBuild.error };
    }
    const instanceResult = await WebAssembly.instantiate(
      module,
      importBuild.imports
    );
    const moduleExports = instanceResult.exports;
    const start = moduleExports["_start"];
    if (typeof start === "function") {
      start();
    }
    run?.(moduleExports);
    return {
      output: String.fromCharCode(...chars)
    };
  } catch (error) {
    return {
      output: String.fromCharCode(...chars),
      runtimeError: error instanceof Error ? error.message : String(error)
    };
  }
}
function runGeneratedJs(jsCode) {
  const logs = [];
  const mockedConsole = {
    log: (...args) => {
      logs.push(args.map((arg) => String(arg)).join(" "));
    },
    error: (...args) => {
      logs.push(args.map((arg) => String(arg)).join(" "));
    },
    warn: (...args) => {
      logs.push(args.map((arg) => String(arg)).join(" "));
    }
  };
  try {
    const runner = new Function("console", jsCode);
    runner(mockedConsole);
    return { output: logs.join("\n") + (logs.length > 0 ? "\n" : "") };
  } catch (error) {
    return {
      output: logs.join("\n") + (logs.length > 0 ? "\n" : ""),
      runtimeError: error instanceof Error ? error.message : String(error)
    };
  }
}
function runGeneratedJsModule(jsCode, run) {
  const logs = [];
  const mockedConsole = {
    log: (...args) => {
      logs.push(args.map((arg) => String(arg)).join(" "));
    },
    error: (...args) => {
      logs.push(args.map((arg) => String(arg)).join(" "));
    },
    warn: (...args) => {
      logs.push(args.map((arg) => String(arg)).join(" "));
    }
  };
  try {
    const exportsObj = {};
    const moduleObj = { exports: exportsObj };
    const requireFn = (_id) => {
      throw new Error("require is not supported");
    };
    const runner = new Function(
      "console",
      "exports",
      "module",
      "require",
      jsCode
    );
    runner(mockedConsole, exportsObj, moduleObj, requireFn);
    const moduleExports = isObjectRecord(moduleObj.exports) ? moduleObj.exports : exportsObj;
    run?.(moduleExports);
    return { output: logs.join("\n") + (logs.length > 0 ? "\n" : "") };
  } catch (error) {
    return {
      output: logs.join("\n") + (logs.length > 0 ? "\n" : ""),
      runtimeError: error instanceof Error ? error.message : String(error)
    };
  }
}
async function buildLibraries(moonc, vfs, libraries, prebuiltArtifacts, target, stdlibArgs) {
  const stdoutParts = [];
  const stderrParts = [];
  const artifacts = [];
  const prepared = [];
  let sortedLibraries;
  try {
    sortedLibraries = sortLibrariesByDependencies(libraries);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      artifacts,
      stdout: "",
      stderr: `${message}
`,
      exitCode: 1
    };
  }
  for (const library of sortedLibraries) {
    const sourceDir = normalizeLibrarySourceDir(library.packageName);
    vfs.mkdir(sourceDir, true);
    const sourcePaths = [];
    for (const file of library.files) {
      const sourcePath = normalizeLibrarySourcePath(sourceDir, file.path);
      vfs.mkdir(dirname(sourcePath), true);
      vfs.writeFile(sourcePath, new TextEncoder().encode(file.source));
      if (file.path.endsWith(".mbt")) {
        sourcePaths.push(sourcePath);
      }
    }
    if (sourcePaths.length === 0) {
      return {
        success: false,
        artifacts,
        stdout: "",
        stderr: `library ${library.packageName} has no .mbt source files
`,
        exitCode: 1
      };
    }
    prepared.push({
      packageName: library.packageName,
      sourceDir,
      sourcePaths,
      imports: collectLibraryImports(library)
    });
  }
  for (const [index, library] of prepared.entries()) {
    const dependencyMiArgs = buildDependencyMiArgs(
      library.imports,
      artifacts,
      prebuiltArtifacts
    );
    const corePath = `/out/library_${index}.core`;
    const miPath = corePath.replace(/\.core$/, ".mi");
    const buildArgs = [
      "moonc",
      "build-package",
      "-target",
      target,
      "-pkg",
      library.packageName,
      "-error-format",
      "json",
      "-o",
      corePath,
      ...dependencyMiArgs,
      ...library.sourcePaths
    ];
    buildArgs.splice(2, 0, ...stdlibArgs);
    const result = await moonc.run(buildArgs);
    stdoutParts.push(result.stdout);
    stderrParts.push(result.stderr);
    if (result.exitCode !== 0) {
      return {
        success: false,
        artifacts,
        stdout: stdoutParts.join(""),
        stderr: stderrParts.join(""),
        exitCode: result.exitCode
      };
    }
    const core = vfs.readFile(corePath);
    if (!core) {
      return {
        success: false,
        artifacts,
        stdout: stdoutParts.join(""),
        stderr: `${stderrParts.join("")}missing ${corePath}
`,
        exitCode: 1
      };
    }
    const mi = vfs.readFile(miPath);
    if (!mi) {
      return {
        success: false,
        artifacts,
        stdout: stdoutParts.join(""),
        stderr: `${stderrParts.join("")}missing ${miPath}
`,
        exitCode: 1
      };
    }
    artifacts.push({
      packageName: library.packageName,
      sourceDir: library.sourceDir,
      corePath,
      miPath
    });
  }
  return {
    success: true,
    artifacts,
    stdout: stdoutParts.join(""),
    stderr: stderrParts.join(""),
    exitCode: 0
  };
}
async function compileFiles(files, options) {
  const mooncLoadOptions = await resolveMooncLoadOptions();
  const stdlib = await getStdlib(options.target);
  const vfs = new MemoryVFS();
  installStdlib(vfs, stdlib);
  vfs.mkdir("/src", true);
  vfs.mkdir("/out", true);
  const sourcePaths = [];
  for (const file of files) {
    const sourcePath = normalizeSourcePath(file.path);
    vfs.mkdir(dirname(sourcePath), true);
    vfs.writeFile(sourcePath, new TextEncoder().encode(file.source));
    sourcePaths.push(sourcePath);
  }
  const stdlibArgs = getStdlibArgs(stdlib);
  const prebuiltPrepare = preparePrebuiltPackages(
    vfs,
    options.prebuiltPackages ?? []
  );
  if (!prebuiltPrepare.success) {
    return {
      success: false,
      stage: "build",
      target: options.target,
      stdout: "",
      stderr: `${prebuiltPrepare.message}
`,
      exitCode: 1
    };
  }
  const localPackageNames = new Set(
    (options.libraries ?? []).map((x) => x.packageName)
  );
  for (const prebuilt of prebuiltPrepare.artifacts) {
    if (localPackageNames.has(prebuilt.packageName)) {
      return {
        success: false,
        stage: "build",
        target: options.target,
        stdout: "",
        stderr: `package ${prebuilt.packageName} is defined both in libraries and prebuiltPackages
`,
        exitCode: 1
      };
    }
  }
  const moonc = await loadMoonc({ ...mooncLoadOptions, vfs });
  const libraryBuild = await buildLibraries(
    moonc,
    vfs,
    options.libraries ?? [],
    prebuiltPrepare.artifacts,
    options.target,
    stdlibArgs
  );
  if (!libraryBuild.success) {
    return {
      success: false,
      stage: "build",
      target: options.target,
      stdout: libraryBuild.stdout,
      stderr: libraryBuild.stderr,
      exitCode: libraryBuild.exitCode
    };
  }
  const buildArgs = [
    "moonc",
    "build-package",
    "-target",
    options.target,
    "-pkg",
    "main",
    "-is-main",
    "-error-format",
    "json",
    "-o",
    "/out/main.core",
    ...buildDependencyMiArgs(
      extractSourcePackageRefEntries(
        files.map((file) => file.source).join("\n")
      ),
      libraryBuild.artifacts,
      prebuiltPrepare.artifacts
    ),
    ...sourcePaths
  ];
  buildArgs.splice(2, 0, ...stdlibArgs);
  if (options.testMode) {
    buildArgs.splice(2, 0, "-test-mode");
  }
  const buildResult = await moonc.run(buildArgs);
  const buildStdout = `${libraryBuild.stdout}${buildResult.stdout}`;
  const buildStderr = `${libraryBuild.stderr}${buildResult.stderr}`;
  if (buildResult.exitCode !== 0) {
    return {
      success: false,
      stage: "build",
      target: options.target,
      stdout: buildStdout,
      stderr: buildStderr,
      exitCode: buildResult.exitCode
    };
  }
  const core = vfs.readFile("/out/main.core");
  if (!core) {
    return {
      success: false,
      stage: "build",
      target: options.target,
      stdout: buildStdout,
      stderr: `${buildStderr}missing /out/main.core
`,
      exitCode: 1
    };
  }
  const outputPath = options.target === "js" ? "/out/main.js" : "/out/main.wasm";
  const linkArgs = [
    "moonc",
    "link-core",
    "-target",
    options.target,
    "-o",
    outputPath,
    "-main",
    "main",
    "-pkg-sources",
    "moonbitlang/core:moonbitlang/core:/lib/core",
    ...libraryBuild.artifacts.flatMap((artifact) => [
      "-pkg-sources",
      `${artifact.packageName}:${artifact.packageName}:${artifact.sourceDir}`
    ]),
    "-pkg-sources",
    "main:main:/src",
    "/lib/core/abort.core",
    "/lib/core/core.core",
    ...prebuiltPrepare.artifacts.map((artifact) => artifact.corePath),
    ...libraryBuild.artifacts.map((artifact) => artifact.corePath),
    "/out/main.core"
  ];
  if (options.testMode) {
    linkArgs.splice(2, 0, "-test-mode");
  }
  if (options.exportedFunctions && options.exportedFunctions.length > 0) {
    linkArgs.splice(
      2,
      0,
      "-exported_functions",
      options.exportedFunctions.join(",")
    );
  }
  if (options.target === "js" && options.jsFormat) {
    linkArgs.splice(2, 0, "-js-format", options.jsFormat);
  }
  const mooncForLink = await loadMoonc({ ...mooncLoadOptions, vfs });
  const linkResult = await mooncForLink.run(linkArgs);
  if (linkResult.exitCode !== 0) {
    return {
      success: false,
      stage: "link",
      target: options.target,
      stdout: `${buildStdout}${linkResult.stdout}`,
      stderr: `${buildStderr}${linkResult.stderr}`,
      exitCode: linkResult.exitCode,
      core
    };
  }
  const output = vfs.readFile(outputPath);
  if (!output) {
    return {
      success: false,
      stage: "link",
      target: options.target,
      stdout: `${buildStdout}${linkResult.stdout}`,
      stderr: `${buildStderr}${linkResult.stderr}missing ${outputPath}
`,
      exitCode: 1,
      core
    };
  }
  return {
    success: true,
    stage: "link",
    target: options.target,
    stdout: `${buildStdout}${linkResult.stdout}`,
    stderr: `${buildStderr}${linkResult.stderr}`,
    exitCode: 0,
    core,
    output
  };
}
async function collectParsedTests(source, filename, _libraries) {
  const mooncLoadOptions = await resolveMooncLoadOptions();
  const vfs = new MemoryVFS();
  const sourcePath = normalizeSourcePath(filename);
  vfs.mkdir(dirname(sourcePath), true);
  vfs.writeFile(sourcePath, new TextEncoder().encode(source));
  const moonc = await loadMoonc({ ...mooncLoadOptions, vfs });
  const result = await moonc.run([
    "moonc",
    "gen-test-info",
    "-target",
    "js",
    "-json",
    sourcePath
  ]);
  if (result.exitCode !== 0) {
    throw new Error(
      result.stderr || result.stdout || "failed to extract test info"
    );
  }
  const payload = result.stdout.trim() || result.stderr.trim();
  if (!payload) {
    return {
      noArgs: [],
      withArgs: [],
      asyncNoArgs: [],
      asyncWithArgs: []
    };
  }
  return parseTestInfo(parseJson(payload, {}));
}
async function collectTests(source, filename, libraries) {
  const parsed = await collectParsedTests(source, filename, libraries);
  return extractNoArgsTests(parsed);
}
async function compileMoonbit(source, target = "js", filename = "main.mbt", libraries = [], prebuiltPackages = []) {
  return compileFiles(
    [{ path: filename, source }],
    { target, libraries, prebuiltPackages }
  );
}
async function runMoonbitTestsJs(source, filename, libraries, prebuiltPackages) {
  const tests = await collectTests(source, filename, libraries);
  if (tests.length === 0) {
    return {
      success: true,
      tests: [],
      stdout: "",
      stderr: "",
      exitCode: 0,
      target: "js"
    };
  }
  const driverSource = generateTestDriver(tests);
  const compiled = await compileFiles(
    [
      { path: filename, source },
      { path: "__generated_test_driver__.mbt", source: driverSource }
    ],
    {
      target: "js",
      jsFormat: "iife",
      testMode: true,
      libraries,
      prebuiltPackages
    }
  );
  if (!compiled.success || !compiled.output) {
    return {
      success: false,
      tests: tests.map((test) => ({
        name: test.name,
        passed: false,
        error: "Compilation failed"
      })),
      stdout: compiled.stdout,
      stderr: compiled.stderr,
      exitCode: compiled.exitCode,
      target: "js"
    };
  }
  const jsCode = new TextDecoder().decode(compiled.output);
  const runResult = runGeneratedJs(jsCode);
  const parsed = parseTestRunOutput(runResult.output);
  const runtimeFailure = normalizeRuntimeFailure(runResult.runtimeError);
  const byName = new Map(parsed.map((item) => [item.name, item]));
  const results = tests.map(
    (test) => byName.get(test.name) ?? {
      name: test.name,
      passed: false,
      error: runtimeFailure ?? "No result"
    }
  );
  const allPassed = results.every((test) => test.passed);
  return {
    success: allPassed && runResult.runtimeError === void 0,
    tests: results,
    stdout: runResult.output,
    stderr: compiled.stderr,
    exitCode: runResult.runtimeError === void 0 ? 0 : 1,
    target: "js",
    js: jsCode,
    runtimeError: runResult.runtimeError
  };
}
function makeCompatResultKey(filename, index) {
  return `${filename}\0${index}`;
}
async function runMoonbitTestsJsCompat(source, filename, libraries, prebuiltPackages) {
  const parsedTests = await collectParsedTests(source, filename, libraries);
  const tests = flattenCompatTests(parsedTests);
  if (tests.length === 0) {
    return {
      success: true,
      tests: [],
      stdout: "",
      stderr: "",
      exitCode: 0,
      target: "js"
    };
  }
  const driverSource = generateMoonCompatTestDriver(tests);
  const compiled = await compileFiles(
    [
      { path: filename, source },
      { path: "__generated_test_driver__.mbt", source: driverSource }
    ],
    {
      target: "js",
      jsFormat: "cjs",
      testMode: true,
      exportedFunctions: [
        "moonbit_test_driver_internal_execute",
        "moonbit_test_driver_finish"
      ],
      libraries,
      prebuiltPackages
    }
  );
  if (!compiled.success || !compiled.output) {
    return {
      success: false,
      tests: tests.map((test) => ({
        name: test.name,
        passed: false,
        error: "Compilation failed"
      })),
      stdout: compiled.stdout,
      stderr: compiled.stderr,
      exitCode: compiled.exitCode,
      target: "js"
    };
  }
  const jsCode = new TextDecoder().decode(compiled.output);
  const runResult = runGeneratedJsModule(jsCode, (moduleExports) => {
    const execute = moduleExports["moonbit_test_driver_internal_execute"];
    const finish = moduleExports["moonbit_test_driver_finish"];
    if (typeof execute !== "function") {
      throw new Error("moonbit_test_driver_internal_execute is not exported");
    }
    for (let slot = 0; slot < tests.length; slot++) {
      execute(slot);
    }
    if (typeof finish === "function") {
      finish();
    }
  });
  const rows = parseMoonTestResultRows(runResult.output);
  const runtimeFailure = normalizeRuntimeFailure(runResult.runtimeError);
  const byKey = new Map(
    rows.map((row) => [makeCompatResultKey(row.filename, row.index), row])
  );
  const results = tests.map((test) => {
    const row = byKey.get(makeCompatResultKey(test.filename, test.index));
    if (!row) {
      return {
        name: test.name,
        passed: false,
        error: runtimeFailure ?? "No result"
      };
    }
    if (row.message.length === 0) {
      return {
        name: row.testName || test.name,
        passed: true
      };
    }
    return {
      name: row.testName || test.name,
      passed: false,
      error: row.message
    };
  });
  const allPassed = results.every((test) => test.passed);
  return {
    success: allPassed && runResult.runtimeError === void 0,
    tests: results,
    stdout: runResult.output,
    stderr: compiled.stderr,
    exitCode: runResult.runtimeError === void 0 ? 0 : 1,
    target: "js",
    js: jsCode,
    runtimeError: runResult.runtimeError
  };
}
async function runMoonbitTestsWasmFirstOnTarget(tests, source, filename, target, libraries, prebuiltPackages) {
  const driverSource = generateWasmGcFirstTestDriver(tests);
  const compiled = await compileFiles(
    [
      { path: filename, source },
      {
        path: `__generated_wasm_first_test_driver_${target}.mbt`,
        source: driverSource
      }
    ],
    {
      target,
      testMode: true,
      exportedFunctions: [
        "moonbit_test_driver_internal_execute",
        "moonbit_test_driver_finish"
      ],
      libraries,
      prebuiltPackages
    }
  );
  if (!compiled.success || !compiled.output) {
    return {
      success: false,
      tests: tests.map((test) => ({
        name: test.name,
        passed: false,
        error: "Compilation failed"
      })),
      stdout: compiled.stdout,
      stderr: compiled.stderr,
      exitCode: compiled.exitCode,
      target
    };
  }
  const runResult = await runGeneratedWasm(compiled.output, (moduleExports) => {
    const execute = moduleExports["moonbit_test_driver_internal_execute"];
    const finish = moduleExports["moonbit_test_driver_finish"];
    if (typeof execute !== "function") {
      throw new Error("moonbit_test_driver_internal_execute is not exported");
    }
    for (let slot = 0; slot < tests.length; slot++) {
      execute(slot);
    }
    if (typeof finish === "function") {
      finish();
    }
  });
  const rows = parseMoonTestResultRows(runResult.output);
  const runtimeFailure = normalizeRuntimeFailure(runResult.runtimeError);
  const byKey = new Map(
    rows.map((row) => [makeCompatResultKey(row.filename, row.index), row])
  );
  const results = tests.map((test) => {
    const row = byKey.get(makeCompatResultKey(test.filename, test.index));
    if (!row) {
      return {
        name: test.name,
        passed: false,
        error: runtimeFailure ?? "No result"
      };
    }
    if (row.message.length === 0) {
      return {
        name: row.testName || test.name,
        passed: true
      };
    }
    return {
      name: row.testName || test.name,
      passed: false,
      error: row.message
    };
  });
  const allPassed = results.every((test) => test.passed);
  return {
    success: allPassed && runResult.runtimeError === void 0,
    tests: results,
    stdout: runResult.output,
    stderr: compiled.stderr,
    exitCode: runResult.runtimeError === void 0 ? 0 : 1,
    target,
    runtimeError: runResult.runtimeError
  };
}
function isCompilerIce(stderr) {
  return stderr.includes(
    "Oops, the compiler has encountered an unexpected situation."
  );
}
function isCompileFailedOnly(result) {
  return result.tests.length > 0 && result.tests.every((test) => test.error === "Compilation failed");
}
function shouldFallbackFromWasmGc(result) {
  if (result.target !== "wasm-gc") return false;
  if (!isCompileFailedOnly(result)) return false;
  return isCompilerIce(result.stderr);
}
async function runMoonbitTestsWasmGcFirst(source, filename, libraries, prebuiltPackages) {
  const parsedTests = await collectParsedTests(source, filename, libraries);
  const tests = flattenCompatTests(parsedTests);
  if (tests.length === 0) {
    return runMoonbitTestsWasm(
      source,
      filename,
      "wasm-gc",
      libraries,
      prebuiltPackages
    );
  }
  const primary = await runMoonbitTestsWasmFirstOnTarget(
    tests,
    source,
    filename,
    "wasm-gc",
    libraries,
    prebuiltPackages
  );
  if (!shouldFallbackFromWasmGc(primary)) {
    return primary;
  }
  const fallback = await runMoonbitTestsWasmFirstOnTarget(
    tests,
    source,
    filename,
    "wasm",
    libraries,
    prebuiltPackages
  );
  if (isCompileFailedOnly(fallback) && isCompilerIce(fallback.stderr)) {
    return {
      ...fallback,
      stderr: [
        "wasm-gc-first: moonc v0.7.2 currently crashes on wasm/wasm-gc when test syntax is lowered this way. Use `fn check_*() -> Bool` as a workaround.",
        primary.stderr,
        fallback.stderr
      ].filter((x) => x.length > 0).join("\n")
    };
  }
  return {
    ...fallback,
    stderr: [
      "[wasm-gc-first] primary wasm-gc failed; fallback to wasm.",
      primary.stderr,
      fallback.stderr
    ].filter((x) => x.length > 0).join("\n")
  };
}
async function runMoonbitTestsWasm(source, filename, target, libraries, prebuiltPackages) {
  if (/\bfn\s+main\b/.test(source)) {
    return {
      success: false,
      tests: [],
      stdout: "",
      stderr: "wasm test mode does not accept `fn main`; define only check_ functions",
      exitCode: 1,
      target
    };
  }
  const checks = extractWasmChecks(source);
  if (checks.length === 0) {
    return {
      success: false,
      tests: [],
      stdout: "",
      stderr: "wasm test mode requires no-arg Bool check functions (e.g. fn check_name() -> Bool)",
      exitCode: 1,
      target
    };
  }
  const driverSource = generateWasmCheckDriver(checks);
  const compiled = await compileFiles(
    [
      { path: filename, source },
      { path: "__generated_wasm_check_driver__.mbt", source: driverSource }
    ],
    { target, libraries, prebuiltPackages }
  );
  if (!compiled.success || !compiled.output) {
    return {
      success: false,
      tests: checks.map((check) => ({
        name: check.name,
        passed: false,
        error: "Compilation failed"
      })),
      stdout: compiled.stdout,
      stderr: compiled.stderr,
      exitCode: compiled.exitCode,
      target
    };
  }
  const runResult = await runGeneratedWasm(compiled.output);
  const parsed = parseTestRunOutput(runResult.output);
  const runtimeFailure = normalizeRuntimeFailure(runResult.runtimeError);
  const byName = new Map(parsed.map((item) => [item.name, item]));
  const results = checks.map(
    (check) => byName.get(check.name) ?? {
      name: check.name,
      passed: false,
      error: runtimeFailure ?? "No result"
    }
  );
  const allPassed = results.every((test) => test.passed);
  return {
    success: allPassed && runResult.runtimeError === void 0,
    tests: results,
    stdout: runResult.output,
    stderr: compiled.stderr,
    exitCode: runResult.runtimeError === void 0 ? 0 : 1,
    runtimeError: runResult.runtimeError,
    target
  };
}
async function runMoonbitTests(source, filename = "main.mbt", target = "js", mode = "simple", libraries = [], prebuiltPackages = []) {
  if (mode === "wasm-gc-first") {
    return runMoonbitTestsWasmGcFirst(
      source,
      filename,
      libraries,
      prebuiltPackages
    );
  }
  if (target === "js") {
    if (mode === "moon-test-compat") {
      return runMoonbitTestsJsCompat(
        source,
        filename,
        libraries,
        prebuiltPackages
      );
    }
    return runMoonbitTestsJs(source, filename, libraries, prebuiltPackages);
  }
  if (target === "wasm-gc") {
    return runMoonbitTestsWasmGcFirst(
      source,
      filename,
      libraries,
      prebuiltPackages
    );
  }
  return runMoonbitTestsWasm(
    source,
    filename,
    target,
    libraries,
    prebuiltPackages
  );
}
function parseSourceFileInput(raw, context) {
  if (!isObjectRecord(raw)) {
    throw new Error(`${context} must be object`);
  }
  if (typeof raw.path !== "string" || !isValidRelativePath(raw.path)) {
    throw new Error(
      `${context}.path must be relative path without '.' or '..' segments`
    );
  }
  if (typeof raw.source !== "string") {
    throw new Error(`${context}.source must be string`);
  }
  return {
    path: raw.path,
    source: raw.source
  };
}
function parseLibraries(raw) {
  if (raw === void 0) {
    return [];
  }
  if (!Array.isArray(raw)) {
    throw new Error("libraries must be array");
  }
  return raw.map((entry, index) => {
    if (!isObjectRecord(entry)) {
      throw new Error(`libraries[${index}] must be object`);
    }
    if (typeof entry.packageName !== "string") {
      throw new Error(`libraries[${index}].packageName must be string`);
    }
    if (!isValidPackageName(entry.packageName)) {
      throw new Error(`libraries[${index}].packageName is invalid`);
    }
    if (!Array.isArray(entry.files) || entry.files.length === 0) {
      throw new Error(`libraries[${index}].files must be non-empty array`);
    }
    const files = entry.files.map(
      (file, fileIndex) => parseSourceFileInput(file, `libraries[${index}].files[${fileIndex}]`)
    );
    return {
      packageName: entry.packageName,
      files
    };
  });
}
function parsePrebuiltPackages(raw) {
  if (raw === void 0) {
    return [];
  }
  if (!Array.isArray(raw)) {
    throw new Error("prebuiltPackages must be array");
  }
  return raw.map((entry, index) => {
    if (!isObjectRecord(entry)) {
      throw new Error(`prebuiltPackages[${index}] must be object`);
    }
    if (typeof entry.packageName !== "string") {
      throw new Error(`prebuiltPackages[${index}].packageName must be string`);
    }
    if (!isValidPackageName(entry.packageName)) {
      throw new Error(`prebuiltPackages[${index}].packageName is invalid`);
    }
    if (typeof entry.miBase64 !== "string" || entry.miBase64.length === 0) {
      throw new Error(
        `prebuiltPackages[${index}].miBase64 must be non-empty string`
      );
    }
    if (typeof entry.coreBase64 !== "string" || entry.coreBase64.length === 0) {
      throw new Error(
        `prebuiltPackages[${index}].coreBase64 must be non-empty string`
      );
    }
    const rawAliases = entry.aliases;
    let aliases = [];
    if (rawAliases !== void 0) {
      if (!Array.isArray(rawAliases)) {
        throw new Error(`prebuiltPackages[${index}].aliases must be array`);
      }
      aliases = rawAliases.map((alias, aliasIndex) => {
        if (typeof alias !== "string" || !isValidAliasName(alias)) {
          throw new Error(
            `prebuiltPackages[${index}].aliases[${aliasIndex}] must match [a-zA-Z0-9_]+`
          );
        }
        return alias;
      });
      aliases = [...new Set(aliases)];
    }
    return {
      packageName: entry.packageName,
      miBase64: entry.miBase64,
      coreBase64: entry.coreBase64,
      aliases
    };
  });
}
async function parseCompileRequest(request) {
  const body = await request.json();
  if (!isObjectRecord(body)) {
    throw new Error("invalid json body");
  }
  const prebuiltPackages = mergePrebuiltPackages(
    parsePrebuiltPackages(body.prebuiltPackages),
    parsePrebuiltPackagesTar(body.prebuiltPackagesTarBase64)
  );
  return {
    source: typeof body.source === "string" ? body.source : "",
    target: normalizeTarget(body.target),
    filename: typeof body.filename === "string" ? body.filename : "main.mbt",
    libraries: parseLibraries(body.libraries),
    prebuiltPackages
  };
}
async function parseTestRequest(request) {
  const body = await request.json();
  if (!isObjectRecord(body)) {
    throw new Error("invalid json body");
  }
  const prebuiltPackages = mergePrebuiltPackages(
    parsePrebuiltPackages(body.prebuiltPackages),
    parsePrebuiltPackagesTar(body.prebuiltPackagesTarBase64)
  );
  return {
    source: typeof body.source === "string" ? body.source : "",
    filename: typeof body.filename === "string" ? body.filename : "main.mbt",
    target: normalizeTarget(body.target),
    mode: normalizeRunnerMode(body.mode),
    libraries: parseLibraries(body.libraries),
    prebuiltPackages
  };
}
async function handleRequest(request) {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/health") {
    return jsonResponse({
      ok: true,
      service: "moonbit-runner",
      runtime: "deno"
    });
  }
  if (request.method === "POST" && url.pathname === "/api/v1/moonbit/compile") {
    try {
      const payload = await parseCompileRequest(request);
      if (!payload.source) {
        return jsonResponse({ ok: false, error: "missing field: source" }, 400);
      }
      const result = await compileMoonbit(
        payload.source,
        payload.target,
        payload.filename,
        payload.libraries,
        payload.prebuiltPackages
      );
      if (!result.success || !result.output) {
        return jsonResponse({
          ok: false,
          success: false,
          stage: result.stage,
          target: result.target,
          stdout: result.stdout,
          stderr: result.stderr,
          exit_code: result.exitCode
        }, 400);
      }
      return jsonResponse({
        ok: true,
        success: true,
        target: result.target,
        stdout: result.stdout,
        stderr: result.stderr,
        exit_code: 0,
        js: result.target === "js" ? new TextDecoder().decode(result.output) : void 0,
        wasm_base64: result.target !== "js" ? toBase64(result.output) : void 0
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return jsonResponse({ ok: false, error: message }, 400);
    }
  }
  if (request.method === "POST" && url.pathname === "/api/v1/moonbit/test") {
    try {
      const payload = await parseTestRequest(request);
      if (!payload.source) {
        return jsonResponse({ ok: false, error: "missing field: source" }, 400);
      }
      const result = await runMoonbitTests(
        payload.source,
        payload.filename,
        payload.target,
        payload.mode,
        payload.libraries,
        payload.prebuiltPackages
      );
      return jsonResponse({
        ok: true,
        success: result.success,
        target: result.target,
        mode: payload.mode ?? "simple",
        tests: result.tests,
        stdout: result.stdout,
        stderr: result.stderr,
        exit_code: result.exitCode,
        runtime_error: result.runtimeError
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return jsonResponse({ ok: false, error: message }, 400);
    }
  }
  return jsonResponse({ ok: false, error: "not found" }, 404);
}
export {
  compileMoonbit,
  handleRequest,
  runMoonbitTests
};
