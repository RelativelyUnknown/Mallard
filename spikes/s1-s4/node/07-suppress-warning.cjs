'use strict';
// Can the extension itself silence the one-off ExperimentalWarning (it cannot pass --disable-warning to the extension host)?
// Technique: temporarily wrap process.emitWarning around the first require('node:sqlite').
const seen = [];
process.on('warning', (w) => seen.push(w.name));
const orig = process.emitWarning;
process.emitWarning = function (warning, ...rest) {
  const type = typeof rest[0] === 'string' ? rest[0] : rest[0] && rest[0].type;
  if (type === 'ExperimentalWarning' && /SQLite/i.test(String(warning && warning.message ? warning.message : warning))) return;
  return orig.call(this, warning, ...rest);
};
let mod;
try {
  mod = require('node:sqlite');
} finally {
  process.emitWarning = orig;
}
setImmediate(() => console.log(JSON.stringify({ node: process.versions.node, loaded: !!mod, warningEventsSeen: seen })));
