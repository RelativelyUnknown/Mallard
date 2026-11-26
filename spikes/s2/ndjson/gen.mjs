// Synthetic Claude-Code-style JSONL generator.
//
//   node spikes/s2/ndjson/gen.mjs <out.jsonl> [--mb 500] [--seed 3]
//
// Line mix (approximates ~/.claude/projects/**.jsonl): ~58% tool_result user lines (2-20 KB), ~12% user prompts
// (1-6 KB), ~1 in 6 `assistant` lines with message.usage (1-8 KB, a quarter are same-message-id duplicates), ~3% small
// summary/system lines, ~0.5% tool_result lines whose toolUseResult carries a `"usage"` object (prefilter false positive).
// Text uses multi-byte UTF-8 (é, 日本語, emoji) and JSON escapes so byte offsets != char offsets.
import fs from 'node:fs';
import { mulberry32, hex, uuid } from '../lib/data.mjs';

const WORDS = ('const let function return import export async await class interface type string number boolean ' +
  'undefined null if else for while switch case break continue try catch finally throw new this super extends implements ' +
  'readonly private public protected static abstract enum namespace module declare require process env path file dir ' +
  'src test build dist node_modules package json yaml config server client request response error warn info debug ' +
  'usage tokens model repo branch commit merge rebase diff patch lint format compile bundle deploy release version ' +
  'héllo wörld naïve façade 日本語のテキスト 中文字符 한국어 🚀 ✅ ❌ — “quoted” ‘single’ \\n \\t \\\\ \\"q\\" \\u001b[31m').split(' ');

export function makeMaster(r, bytes = 6 << 20) {
  const parts = [];
  let n = 0;
  while (n < bytes) {
    const w = WORDS[Math.floor(r() * WORDS.length)];
    const sep = r() < 0.08 ? '\\n' : ' ';
    parts.push(w, sep === ' ' ? ' ' : `\\n `); // every token boundary is a raw space => safe slicing points
    n += w.length + 2;
  }
  return parts.join('');
}

export class LineGen {
  constructor({ seed = 3, startTs = Date.UTC(2026, 9, 1), master } = {}) {
    this.r = mulberry32(seed);
    this.master = master ?? makeMaster(this.r);
    this.ts = startTs;
    this.sessionId = uuid(this.r);
    this.parent = uuid(this.r);
    this.msgId = null;
    this.stats = { lines: 0, assistant: 0, assistantUnique: 0, usageLines: 0, falsePositives: 0, bytes: 0, outputTokens: 0 };
  }
  text(minBytes, maxBytes) {
    const r = this.r;
    const len = Math.floor(minBytes + r() * r() * (maxBytes - minBytes)); // skew toward smaller
    let s = Math.floor(r() * (this.master.length - maxBytes - 2));
    s = this.master.indexOf(' ', s) + 1;
    let e = this.master.indexOf(' ', s + len);
    if (e < 0) e = s + len;
    return this.master.slice(s, e);
  }
  base(type) {
    this.ts += 1000 + Math.floor(this.r() * 30000);
    const uid = uuid(this.r);
    const head = `{"parentUuid":"${this.parent}","isSidechain":${this.r() < 0.05},"userType":"external","cwd":"/home/dev/projects/repo-${Math.floor(this.r() * 9)}","sessionId":"${this.sessionId}","version":"2.0.31","gitBranch":"main","type":"${type}"`;
    this.parent = uid;
    return { head, uid, ts: new Date(this.ts).toISOString() };
  }
  next() {
    const r = this.r;
    const x = r();
    let line;
    if (x < 1 / 6) {
      const dup = this.msgId && r() < 0.25; // streamed content blocks share message.id + usage
      const msgId = dup ? this.msgId : `msg_${hex(r, 24)}`;
      this.msgId = msgId;
      const { head, uid, ts } = this.base('assistant');
      const model = r() < 0.7 ? 'claude-sonnet-4-5-20250929' : r() < 0.5 ? 'claude-opus-4-1-20250805' : 'claude-haiku-4-5-20251001';
      const out = Math.floor(10 + r() * 3000), inp = Math.floor(r() * 50), cr = Math.floor(r() * 150000), cw = r() < 0.3 ? Math.floor(r() * 9000) : 0;
      const content = r() < 0.5
        ? `[{"type":"text","text":"${this.text(200, 6000)}"}]`
        : `[{"type":"tool_use","id":"toolu_${hex(r, 22)}","name":"Bash","input":{"command":"${this.text(40, 400)}","description":"${this.text(20, 120)}"}}]`;
      line = `${head},"message":{"id":"${msgId}","type":"message","role":"assistant","model":"${model}","content":${content},"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":${inp},"cache_creation_input_tokens":${cw},"cache_read_input_tokens":${cr},"output_tokens":${out},"service_tier":"standard"}},"requestId":"req_${hex(r, 22)}","uuid":"${uid}","timestamp":"${ts}"}`;
      this.stats.assistant++;
      this.stats.usageLines++;
      if (!dup) { this.stats.assistantUnique++; }
      this.stats.outputTokens += out;
    } else if (x < 1 / 6 + 0.58) {
      const { head, uid, ts } = this.base('user');
      const fp = r() < 0.008; // subagent result carrying a usage object => prefilter false positive
      const body = this.text(2000, 20000);
      const tur = fp
        ? `{"status":"completed","totalDurationMs":${Math.floor(r() * 90000)},"totalTokens":${Math.floor(r() * 90000)},"usage":{"input_tokens":3,"output_tokens":${Math.floor(r() * 900)},"cache_read_input_tokens":0},"content":[{"type":"text","text":"${this.text(100, 800)}"}]}`
        : `{"stdout":"${this.text(100, 1500)}","stderr":"","interrupted":false}`;
      line = `${head},"message":{"role":"user","content":[{"tool_use_id":"toolu_${hex(r, 22)}","type":"tool_result","content":"${body}"}]},"uuid":"${uid}","timestamp":"${ts}","toolUseResult":${tur}}`;
      if (fp) { this.stats.falsePositives++; this.stats.usageLines++; }
    } else if (x < 1 / 6 + 0.58 + 0.12) {
      const { head, uid, ts } = this.base('user');
      line = `${head},"message":{"role":"user","content":"${this.text(300, 6000)}"},"uuid":"${uid}","timestamp":"${ts}"}`;
    } else {
      line = r() < 0.5
        ? `{"type":"summary","summary":"${this.text(40, 200)}","leafUuid":"${uuid(r)}"}`
        : `{"parentUuid":"${this.parent}","type":"system","subtype":"informational","content":"${this.text(40, 400)}","level":"info","uuid":"${uuid(r)}","timestamp":"${new Date(this.ts).toISOString()}"}`;
    }
    this.stats.lines++;
    this.stats.bytes += Buffer.byteLength(line) + 1;
    return line;
  }
}

export function generateFile(file, mb, seed = 3) {
  const gen = new LineGen({ seed });
  const fd = fs.openSync(file, 'w');
  const target = mb * 1024 * 1024;
  let pending = [];
  let pendingBytes = 0;
  const flush = () => { fs.writeSync(fd, `${pending.join('\n')}\n`); pending = []; pendingBytes = 0; };
  while (gen.stats.bytes < target) {
    const l = gen.next();
    pending.push(l);
    pendingBytes += l.length;
    if (pendingBytes > 4 << 20) flush();
  }
  if (pending.length) flush();
  fs.closeSync(fd);
  return gen;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = process.argv[2];
  const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? +process.argv[i + 1] : d; };
  const mb = arg('mb', 500);
  const seed = arg('seed', 3);
  const t0 = performance.now();
  const gen = generateFile(out, mb, seed);
  const meta = { ...gen.stats, seed, mb };
  fs.writeFileSync(`${out}.meta.json`, JSON.stringify(meta));
  console.log(`wrote ${out}: ${(gen.stats.bytes / 2 ** 20).toFixed(0)} MiB, ${gen.stats.lines} lines in ${((performance.now() - t0) / 1000).toFixed(1)} s`, meta);
}
