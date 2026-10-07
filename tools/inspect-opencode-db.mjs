// 查看 opencode.db 的 credential / account 表，弄清登录后到底存了什么类型的凭据
import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync(process.argv[2], { readOnly: true });

function mask(v) {
  if (typeof v !== 'string') return v;
  if (v.length <= 24) return v;
  return `${v.slice(0, 14)}…(${v.length} 字符)`;
}

for (const t of ['credential', 'account', 'account_state']) {
  let cols;
  try {
    cols = db.prepare(`PRAGMA table_info(${t})`).all();
  } catch {
    continue;
  }
  if (!cols.length) continue;
  console.log(`\n=== ${t} (${cols.map((c) => c.name).join(', ')}) ===`);
  let rows = [];
  try {
    rows = db.prepare(`SELECT * FROM ${t}`).all();
  } catch (e) {
    console.log('  ERR', e.message);
    continue;
  }
  if (!rows.length) {
    console.log('  (空)');
    continue;
  }
  for (const r of rows) {
    const o = {};
    for (const [k, v] of Object.entries(r)) {
      o[k] = /token|key|secret|password/i.test(k) && typeof v === 'string' && v.length > 24 ? mask(v) : v;
    }
    console.log('  ' + JSON.stringify(o));
  }
}
db.close();
