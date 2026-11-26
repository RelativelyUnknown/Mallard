import { canon } from './canon';

/**
 * The first few differences between a recording and a fresh computation, as
 * readable paths (`snapshots[3].data.daily[2].cost: recorded 1.5, got 1.6`),
 * or null when they agree. The result is canonicalised first (key order,
 * 10-significant-digit floats); the recording is read back from JSON as-is
 * because the recorder already wrote it canonical.
 */
export function diffGolden(actual: unknown, expected: unknown, limit = 6): string | null {
  const diffs: string[] = [];
  const walk = (a: unknown, e: unknown, at: string): void => {
    if (diffs.length >= limit || a === e) return;
    const aObj = a !== null && typeof a === 'object';
    const eObj = e !== null && typeof e === 'object';
    if (aObj && eObj && Array.isArray(a) === Array.isArray(e)) {
      if (Array.isArray(a)) {
        const eArr = e as unknown[];
        if (a.length !== eArr.length) diffs.push(`${at}: recorded ${eArr.length} entries, got ${a.length}`);
        for (let i = 0; i < Math.min(a.length, eArr.length); i++) walk(a[i], eArr[i], `${at}[${i}]`);
        return;
      }
      const aRec = a as Record<string, unknown>;
      const eRec = e as Record<string, unknown>;
      for (const k of new Set([...Object.keys(aRec), ...Object.keys(eRec)])) {
        if (!(k in aRec)) diffs.push(`${at}.${k}: recorded, but missing from the result`);
        else if (!(k in eRec)) diffs.push(`${at}.${k}: in the result, but not recorded`);
        else walk(aRec[k], eRec[k], `${at}.${k}`);
      }
      return;
    }
    diffs.push(`${at}: recorded ${JSON.stringify(e)}, got ${JSON.stringify(a)}`);
  };
  walk(canon(actual), expected, '$');
  return diffs.length === 0 ? null : diffs.join('\n');
}
