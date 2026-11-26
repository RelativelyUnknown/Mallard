// Appends the markdown tables stored in results/*.json to RESULTS.md (everything after the "## Appendix" heading is
// regenerated). Usage: node spikes/s2/make-appendix.mjs
import fs from 'node:fs';
const root = new URL('.', import.meta.url);
const read = (n) => JSON.parse(fs.readFileSync(new URL(`results/${n}.json`, root), 'utf8'));
const md = fs.readFileSync(new URL('RESULTS.md', root), 'utf8');
const marker = '## Appendix: full tables (generated from `results/*.json`)';
const head = md.slice(0, md.indexOf(marker) + marker.length);
const sections = [];
const add = (title, body) => sections.push(`\n\n### ${title}\n\n${body}`);

const ins = read('insert');
add('A1. Inserts (100k rows; 5 runs per cell; EL = monitorEventLoopDelay, 1 ms timer resolution subtracted)', ins.table);
add('A1b. Insert soak (20 runs x 50 batches of 2000 rows per mode)', read('insert_soak').table);
add('A1c. Cold start (fresh process, 4 consecutive 2000-row batches)', read('cold').table);
add('A2. Fresh-row detection strategies', read('fresh').table);
for (const d of ['clustered', 'uniform']) add(`A3. Snapshot reads, ${d} data (50k raw + 5k rollups; ms)`, read(`read-${d}`).table);
add('A4. NDJSON (500 MiB)', read('ndjson').table);
add('A5. Concurrency', read('concurrency').table);
const w = read('worker');
add('A6. Worker snapshots', w.tables.snapshots);
add('A6b. Worker ingest', w.tables.write);
const m = ins.machine;
add('A7. Machine record', '```json\n' + JSON.stringify(m, null, 2) + '\n```');
fs.writeFileSync(new URL('RESULTS.md', root), head + sections.join('') + '\n');
console.log('appendix written');
