/**
 * In-memory `GridEngine` for unit tests (no gridstack, no layout). `update()` applies a patch with
 * clamping and NO gravity and no collision handling, which is all the controller and keyboard tests
 * need; gravity and collisions are covered against the real adapter (gridstackEngine.test.ts) and
 * the Playwright smoke test (test/webview). Like the real engine: only `update()` emits `change`
 * (`registerAll`/`add`/`unregister`/`load` are silent), and `unregister`/`add` toggle `el.hidden`.
 */
import type { ChangeInfo, EngineOptions, GridEngine, PanelRect } from '../../../src/extension-frontend/gridEngine';

export class FakeEngine implements GridEngine {
  readonly rects = new Map<string, PanelRect>();
  readonly els = new Map<string, HTMLElement>();
  readonly calls: string[] = [];
  mountedWith: EngineOptions | undefined;
  private cols = 4;
  private fixed = true;
  private changeCbs = new Set<(i: ChangeInfo) => void>();
  private columnCbs = new Set<(c: number) => void>();

  mount(_root: HTMLElement, opts: EngineOptions): void {
    this.mountedWith = opts;
    this.cols = opts.columns;
    this.calls.push('mount');
  }
  registerAll(entries: ReadonlyArray<{ id: string; el: HTMLElement; rect: PanelRect }>): void {
    for (const e of entries) {
      this.rects.set(e.id, { ...e.rect, id: e.id });
      this.els.set(e.id, e.el);
    }
    this.calls.push(`registerAll:${entries.map((e) => e.id).join(',')}`);
  }
  add(id: string, el: HTMLElement, rect: PanelRect): void {
    this.rects.set(id, { ...rect, id });
    this.els.set(id, el);
    el.hidden = false;
    this.calls.push(`add:${id}`);
  }
  unregister(id: string): PanelRect | null {
    const r = this.rects.get(id) ?? null;
    if (!r) return null;
    this.rects.delete(id);
    this.els.get(id)!.hidden = true;
    this.calls.push(`unregister:${id}`);
    return { ...r };
  }
  isRegistered(id: string): boolean {
    return this.rects.has(id);
  }
  setStatic(v: boolean): void {
    this.fixed = v;
    this.calls.push(`setStatic:${v}`);
  }
  isStatic(): boolean {
    return this.fixed;
  }
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
  rect(id: string): PanelRect | null {
    const r = this.rects.get(id);
    return r ? { ...r } : null;
  }
  save(): PanelRect[] {
    return [...this.rects.values()].map((r) => ({ ...r })).sort((a, b) => a.y - b.y || a.x - b.x);
  }
  load(list: PanelRect[]): void {
    for (const r of list) if (this.rects.has(r.id)) this.rects.set(r.id, { ...r });
    this.calls.push(`load:${list.map((r) => r.id).join(',')}`);
  }
  columns(): number {
    return this.cols;
  }
  onChange(cb: (i: ChangeInfo) => void): () => void {
    this.changeCbs.add(cb);
    return () => this.changeCbs.delete(cb);
  }
  onColumnChange(cb: (c: number) => void): () => void {
    this.columnCbs.add(cb);
    return () => this.columnCbs.delete(cb);
  }
  destroy(): void {
    this.calls.push('destroy');
  }

  /** Test helper: simulate a breakpoint switch. */
  setColumns(c: number): void {
    this.cols = c;
    this.columnCbs.forEach((cb) => cb(c));
  }
  /** Test helper: emit a `change` the way gridstack does after a pointer drag or resize (the rects are already in place). */
  emit(info: Partial<ChangeInfo> = {}): void {
    const full: ChangeInfo = { rects: this.save(), column: this.cols, ignorable: false, ...info };
    this.changeCbs.forEach((cb) => cb(full));
  }
  /** Test helper: move a panel the way a pointer drag would (silently, then `emit()`). */
  dragTo(id: string, rect: Partial<Omit<PanelRect, 'id'>>): void {
    this.rects.set(id, { ...this.rects.get(id)!, ...rect });
  }
}
