import { Worker } from 'node:worker_threads';
import { webcrypto } from 'node:crypto';
import { File as NodeFile } from 'node:buffer';

if (!globalThis.crypto) globalThis.crypto = webcrypto;
if (!globalThis.File && NodeFile) globalThis.File = NodeFile;

let NativeDatabaseSync = null;
try {
  const mod = await import('node:sqlite');
  NativeDatabaseSync = mod.DatabaseSync;
} catch {}

let bridgeWorker = null;
let bridgeSab = null;
let bridgeI32 = null;
let bridgeU8 = null;
let nextBridgeDbId = 1;

async function ensureBridge() {
  if (bridgeWorker) return;
  const pyCode = [
    'import sys, json, sqlite3, base64',
    'dbs = {}',
    'def norm_param(p):',
    '  if isinstance(p, dict) and p.get("__b64__"):',
    '    return base64.b64decode(p["__b64__"])',
    '  return p',
    'def norm_val(v):',
    '  if isinstance(v, (bytes, bytearray, memoryview)):',
    '    return {"__b64__": base64.b64encode(bytes(v)).decode("ascii")}',
    '  return v',
    'for line in sys.stdin:',
    '  req = json.loads(line)',
    '  db_id = req.get("db", 1)',
    '  op = req["op"]',
    '  try:',
    '    if op == "open":',
    '      conn = sqlite3.connect(req["filename"], isolation_level=None)',
    '      conn.row_factory = sqlite3.Row',
    '      dbs[db_id] = conn',
    '      res = {"ok": True}',
    '    elif op == "close":',
    '      if db_id in dbs: dbs[db_id].close(); del dbs[db_id]',
    '      res = {"ok": True}',
    '    elif op == "exec":',
    '      sql_text = req["sql"].strip()',
    '      if sql_text.upper() in ("BEGIN", "COMMIT", "ROLLBACK") or ";" not in sql_text.rstrip(";"):',
    '        dbs[db_id].execute(sql_text)',
    '      else:',
    '        dbs[db_id].executescript(sql_text)',
    '      res = {"ok": True}',
    '    elif op in ("get", "all", "run"):',
    '      cur = dbs[db_id].cursor()',
    '      params = [norm_param(x) for x in req.get("params", [])]',
    '      cur.execute(req["sql"], params)',
    '      if op == "get":',
    '        row = cur.fetchone()',
    '        res = {"ok": True, "data": {k: norm_val(row[k]) for k in row.keys()} if row is not None else None}',
    '      elif op == "all":',
    '        rows = cur.fetchall()',
    '        res = {"ok": True, "data": [{k: norm_val(r[k]) for k in r.keys()} for r in rows]}',
    '      else:',
    '        res = {"ok": True, "data": {"changes": cur.rowcount if cur.rowcount >= 0 else 0, "lastInsertRowid": cur.lastrowid or 0}}',
    '    else:',
    '      res = {"ok": False, "error": "Unknown op"}',
    '  except Exception as e:',
    '    res = {"ok": False, "error": str(e)}',
    '  sys.stdout.write(json.dumps(res) + "\\n")',
    '  sys.stdout.flush()'
  ].join('\n');

  bridgeSab = new SharedArrayBuffer(8 * 1024 * 1024);
  bridgeI32 = new Int32Array(bridgeSab, 0, 2);
  bridgeU8 = new Uint8Array(bridgeSab, 8);

  const workerCode = `
    const { parentPort, workerData } = require("node:worker_threads");
    const { spawn } = require("node:child_process");
    const py = spawn("python3", ["-u", "-c", workerData.pyCode]);
    py.unref();
    const i32 = new Int32Array(workerData.sab, 0, 2);
    const u8 = new Uint8Array(workerData.sab, 8);
    let buf = "", currentResolve = null;
    py.stdout.on("data", chunk => {
      buf += chunk.toString();
      let idx;
      while ((idx = buf.indexOf("\\n")) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (currentResolve) { const r = currentResolve; currentResolve = null; r(line); }
      }
    });
    py.stderr.on("data", chunk => {
      if (currentResolve) {
        const r = currentResolve; currentResolve = null;
        r(JSON.stringify({ ok: false, error: chunk.toString() }));
      }
    });
    parentPort.on("message", async (payload) => {
      const line = await new Promise(resolve => { currentResolve = resolve; py.stdin.write(payload + "\\n"); });
      const bytes = Buffer.from(line, "utf8");
      u8.set(bytes.subarray(0, u8.byteLength));
      i32[1] = bytes.byteLength;
      Atomics.store(i32, 0, 1);
      Atomics.notify(i32, 0, 1);
    });
    parentPort.postMessage("ready");
  `;
  bridgeWorker = new Worker(workerCode, { eval: true, workerData: { pyCode, sab: bridgeSab } });
  await new Promise(resolve => bridgeWorker.once('message', resolve));
  bridgeWorker.unref();
}

if (!NativeDatabaseSync) {
  await ensureBridge();
}

function callBridge(req) {
  Atomics.store(bridgeI32, 0, 0);
  bridgeWorker.postMessage(JSON.stringify(req));
  const waitRes = Atomics.wait(bridgeI32, 0, 0, 15000);
  if (waitRes === 'timed-out') throw new Error('SQLite bridge timed out');
  const res = JSON.parse(Buffer.from(bridgeU8.buffer, 8, bridgeI32[1]).toString('utf8'));
  if (!res.ok) throw new Error(res.error);
  return res.data;
}

function encodeParams(params) {
  return params.map(p => {
    if (p === undefined) return null;
    if (typeof p === 'boolean') return p ? 1 : 0;
    if (p instanceof Uint8Array || p instanceof ArrayBuffer || ArrayBuffer.isView(p)) {
      const bytes = p instanceof Uint8Array ? p : new Uint8Array(p.buffer || p, p.byteOffset || 0, p.byteLength ?? p.length);
      return { __b64__: Buffer.from(bytes).toString('base64') };
    }
    return p;
  });
}

function decodeRow(row) {
  if (!row || typeof row !== 'object') return row;
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    if (v && typeof v === 'object' && v.__b64__) out[k] = new Uint8Array(Buffer.from(v.__b64__, 'base64'));
    else out[k] = v;
  }
  return out;
}

class FallbackDatabaseSync {
  constructor(filename = ':memory:') {
    this._id = nextBridgeDbId++;
    callBridge({ db: this._id, op: 'open', filename });
  }
  exec(sql) {
    callBridge({ db: this._id, op: 'exec', sql: String(sql) });
  }
  prepare(sql) {
    const dbId = this._id;
    const text = String(sql);
    return {
      get(...params) {
        return decodeRow(callBridge({ db: dbId, op: 'get', sql: text, params: encodeParams(params) }));
      },
      all(...params) {
        const rows = callBridge({ db: dbId, op: 'all', sql: text, params: encodeParams(params) }) || [];
        return rows.map(decodeRow);
      },
      run(...params) {
        return callBridge({ db: dbId, op: 'run', sql: text, params: encodeParams(params) });
      }
    };
  }
  close() {
    callBridge({ db: this._id, op: 'close' });
  }
}

export const DatabaseSync = NativeDatabaseSync || FallbackDatabaseSync;

export function database(filename = ':memory:') {
  const sql = new DatabaseSync(filename);
  sql.exec('PRAGMA foreign_keys=ON');
  const wrap = (text, params = []) => ({
    bind(...values) { return wrap(text, values); },
    async first() { return sql.prepare(text).get(...params) || null; },
    async all() { return { results: sql.prepare(text).all(...params) }; },
    async run() {
      const r = sql.prepare(text).run(...params);
      return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
    }
  });
  return {
    exec: async text => sql.exec(text),
    prepare: text => wrap(text),
    async batch(statements) {
      sql.exec('BEGIN');
      try {
        const out = [];
        for (const s of statements) out.push(await s.run());
        sql.exec('COMMIT');
        return out;
      } catch (e) {
        try { sql.exec('ROLLBACK'); } catch {}
        throw e;
      }
    },
    sql
  };
}
