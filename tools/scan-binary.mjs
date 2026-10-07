// Scan a binary for needles and print context around each hit (ASCII/UTF-8).
import { open } from 'node:fs/promises';

const [file, ...needleArgs] = process.argv.slice(2);
const needles = needleArgs.length ? needleArgs : ['exo-free', 'x-opencode-request', 'resp_', 'msg_'];
const CHUNK = 8 * 1024 * 1024;
const OVERLAP = 512;

const fh = await open(file, 'r');
const stat = await fh.stat();
console.log(`file=${file} size=${stat.size}`);
const found = new Map(needles.map((n) => [n, []]));

let pos = 0;
let carry = Buffer.alloc(0);
while (pos < stat.size) {
  const len = Math.min(CHUNK, stat.size - pos);
  const buf = await fh.read(Buffer.alloc(len), 0, len, pos);
  const hay = Buffer.concat([carry, buf.buffer.subarray(0, buf.bytesRead)]);
  for (const n of needles) {
    const nb = Buffer.from(n, 'utf8');
    let idx = hay.indexOf(nb);
    while (idx !== -1) {
      const hits = found.get(n);
      if (hits.length < 40) {
        const s = Math.max(0, idx - 160);
        const e = Math.min(hay.length, idx + n.length + 160);
        hits.push({ off: pos - carry.length + idx, ctx: hay.subarray(s, e).toString('latin1') });
      }
      idx = hay.indexOf(nb, idx + 1);
    }
  }
  carry = hay.subarray(Math.max(0, hay.length - OVERLAP));
  pos += buf.bytesRead;
}
await fh.close();

for (const [n, hits] of found) {
  console.log(`\n########## ${n}: ${hits.length} hit(s) ##########`);
  for (const h of hits) {
    console.log(`--- offset ${h.off} ---`);
    console.log(h.ctx.replace(/[^\x20-\x7e\n]/g, '.'));
  }
}
