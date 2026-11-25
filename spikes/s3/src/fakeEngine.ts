/**
 * In-memory `GridEngine` for unit tests (no gridstack, no layout). It applies patches verbatim with
 * clamping and no gravity, which is all the keyboard layer / persistence / migrator tests need.
 * Real gravity/collision behaviour is covered by the Playwright smoke test against GridstackEngine.
 */
import type { ChangeInfo, EngineOptions, GridEngine, PanelRect } from './gridEngine';

export class FakeEngine implements GridEngine {
  private rects = new Map<string, PanelRect>();
  private parked = new Map<string, PanelRect>();
  private cols = 4;
  private statik = true;
  private changeCbs = new Set<(i: ChangeInfo) => void>();
  private columnCbs = new Set<(c: number) => void>();
  readonly calls: string[] = [];

  mount(_root: HTMLElement, opts: EngineOptions): void {
    this.cols = opts.columns;
    this.calls.push('mount');
  }
  register(id: string, _el: HTMLElement, rect: PanelRect): void {
    this.rects.set(id, { ...rect, id });
    this.calls.push(`register:${id}`);
  }
  registerAll(entries: ReadonlyArray<{ id: string; el: HTMLElement; rect: PanelRect }>): void {
    for (const e of entries) this.register(e.id, e.el, e.rect);
    this.calls.push('registerAll');
  }
  unregister(id: string): PanelRect | null {
    const r = this.rects.get(id) ?? null;
    if (r) { this.parked.set(id, r); this.rects.delete(id); }
    this.calls.push(`unregister:${id}`);
    return r;
  }
  reregister(id: string, rect?: Partial<PanelRect>): void {
    const prev = this.parked.get(id);
    if (!prev) return;
    this.rects.set(id, { ...prev, ...rect, id });
    this.parked.delete(id);
    this.calls.push(`reregister:${id}`);
  }
  isRegistered(id: string): boolean { return this.rects.has(id); }
  setStatic(v: boolean): void { this.statik = v; this.calls.push(`setStatic:${v}`); }
  isStatic(): boolean { return this.statik; }
  update(id: string, patch: Partial<Omit<PanelRect, 'id'>>): PanelRect | null {
    const r = this.rects.get(id);
    if (!r) return null;
    const w = Math.min(Math.max(patch.w ?? r.w, 1), this.cols);
    const next = { ...r, ...patch, w, x: Math.min(Math.max(patch.x ?? r.x, 0), this.cols - w), y: Math.max(patch.y ?? r.y, 0) };
    this.rects.set(id, next);
    this.calls.push(`update:${id}:${JSON.stringify(patch)}`);
    this.emit();
    return { ...next };
  }
  rect(id: string): PanelRect | null { const r = this.rects.get(id); return r ? { ...r } : null; }
  save(): PanelRect[] { return [...this.rects.values()].map((r) => ({ ...r })).sort((a, b) => a.y - b.y || a.x - b.x); }
  load(list: PanelRect[]): void {
    for (const r of list) if (this.rects.has(r.id)) this.rects.set(r.id, { ...r });
    this.calls.push('load');
    this.emit();
  }
  columns(): number { return this.cols; }
  /** Test helper: simulate a breakpoint switch. */
  setColumns(c: number): void { this.cols = c; this.columnCbs.forEach((cb) => cb(c)); }
  onChange(cb: (i: ChangeInfo) => void): () => void { this.changeCbs.add(cb); return () => this.changeCbs.delete(cb); }
  onColumnChange(cb: (c: number) => void): () => void { this.columnCbs.add(cb); return () => this.columnCbs.delete(cb); }
  destroy(): void { this.calls.push('destroy'); }
  private emit(): void {
    const info: ChangeInfo = { rects: this.save(), column: this.cols, ignorable: false };
    this.changeCbs.forEach((cb) => cb(info));
  }
}
