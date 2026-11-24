import { strict as assert } from 'assert';
import { mountLayout } from '../../../src/extension-frontend/layout';
import type { DashboardLayout } from '../../../src/extension-backend/domain/types';

function makePanels(ids: string[]): Record<string, HTMLElement> {
  const panels: Record<string, HTMLElement> = {};
  for (const id of ids) {
    const el = document.createElement('div');
    el.className = 'wv-chart-section';
    document.body.appendChild(el);
    panels[id] = el;
  }
  return panels;
}

function baseLayout(ids: string[]): DashboardLayout {
  return ids.map((id) => ({ id, span: 1 as const, hidden: false }));
}

describe('layout — apply() leaves an unchanged DOM order alone', () => {
  it('does not detach panels (and so does not blur a focused resize handle) when the host echoes the same layout', () => {
    const grid = document.createElement('div');
    document.body.appendChild(grid);
    const panels = makePanels(['a', 'b']);
    const mgr = mountLayout(grid, panels, () => {});
    mgr.apply(baseLayout(['a', 'b']));
    mgr.setMode('resize');

    const handle = panels.a!.querySelector<HTMLElement>('.wv-resize-handle--right')!;
    handle.focus();
    assert.equal(document.activeElement, handle);

    mgr.apply(baseLayout(['a', 'b']));
    assert.equal(document.activeElement, handle, 'focus survives a layout echo');

    // A same-order echo carrying new span/size still updates the panels in place.
    mgr.apply([{ id: 'a', span: 2, size: 'tall', hidden: false }, { id: 'b', span: 1, hidden: false }]);
    assert.equal(document.activeElement, handle);
    assert.equal(panels.a!.dataset.span, '2');
    assert.equal(panels.a!.dataset.size, 'tall');
    grid.remove();
  });

  it('still reorders the DOM when the order really differs', () => {
    const grid = document.createElement('div');
    document.body.appendChild(grid);
    const panels = makePanels(['a', 'b', 'c']);
    const mgr = mountLayout(grid, panels, () => {});
    mgr.apply(baseLayout(['a', 'b', 'c']));
    assert.deepEqual([...grid.children], [panels.a, panels.b, panels.c]);

    mgr.apply(baseLayout(['c', 'a', 'b']));
    assert.deepEqual([...grid.children], [panels.c, panels.a, panels.b]);
    grid.remove();
  });
});

describe('layout — a drag does not also count as a tap', () => {
  function setup(): { grid: HTMLElement; el: HTMLElement; handle: HTMLElement } {
    const grid = document.createElement('div');
    document.body.appendChild(grid);
    const panels = makePanels(['a']);
    const mgr = mountLayout(grid, panels, () => {});
    mgr.apply(baseLayout(['a']));
    mgr.setMode('resize');
    const el = panels.a!;
    const rect = { width: 300, height: 120, left: 0, top: 0, right: 300, bottom: 120, x: 0, y: 0, toJSON() { return this; } };
    el.getBoundingClientRect = () => rect as DOMRect;
    return { grid, el, handle: el.querySelector<HTMLElement>('.wv-resize-handle--right')! };
  }
  const ptr = (type: string, x: number) =>
    new window.PointerEvent(type, { bubbles: true, clientX: x, clientY: 0, pointerId: 1 });

  it('the click that follows a drag release is swallowed instead of cycling the width again', () => {
    const { grid, el, handle } = setup();
    handle.dispatchEvent(ptr('pointerdown', 0));
    handle.dispatchEvent(ptr('pointermove', 300));
    assert.equal(el.dataset.span, '2', 'the drag widened the panel');
    handle.dispatchEvent(ptr('pointerup', 300));

    handle.click(); // the browser's click after the drag
    assert.equal(el.dataset.span, '2', 'must not cycle back to 1');

    handle.click(); // the next, genuine tap
    assert.equal(el.dataset.span, '1');
    grid.remove();
  });

  it('a press that barely moves is still a tap', () => {
    const { grid, el, handle } = setup();
    handle.dispatchEvent(ptr('pointerdown', 0));
    handle.dispatchEvent(ptr('pointermove', 2));
    handle.dispatchEvent(ptr('pointerup', 2));
    handle.click();
    assert.equal(el.dataset.span, '2', 'cycled 1 -> 2');
    grid.remove();
  });

  it('a drag released off the handle (no click follows) does not eat the next tap', async () => {
    const { grid, el, handle } = setup();
    handle.dispatchEvent(ptr('pointerdown', 0));
    handle.dispatchEvent(ptr('pointermove', 300));
    handle.dispatchEvent(ptr('pointerup', 300));
    assert.equal(el.dataset.span, '2');

    await new Promise((r) => setTimeout(r, 150));
    handle.click();
    assert.equal(el.dataset.span, '1', 'the tap after the grace period cycles normally');
    grid.remove();
  });
});

describe('layout — accessibility attributes', () => {
  it('slider handles expose aria-valuenow/min/max and keep them in step with the panel', () => {
    const grid = document.createElement('div');
    document.body.appendChild(grid);
    const panels = makePanels(['a']);
    const mgr = mountLayout(grid, panels, () => {});
    mgr.apply([{ id: 'a', span: 1, size: 'normal', hidden: false }]);

    const right = panels.a!.querySelector<HTMLElement>('.wv-resize-handle--right')!;
    const bottom = panels.a!.querySelector<HTMLElement>('.wv-resize-handle--bottom')!;
    const corner = panels.a!.querySelector<HTMLElement>('.wv-resize-handle--corner')!;
    for (const h of [right, bottom, corner]) assert.equal(h.getAttribute('role'), 'slider');

    assert.deepEqual(
      [right.getAttribute('aria-valuemin'), right.getAttribute('aria-valuenow'), right.getAttribute('aria-valuemax')],
      ['1', '1', '2'],
    );
    assert.equal(right.getAttribute('aria-valuetext'), '1 of 2 columns');
    assert.deepEqual(
      [bottom.getAttribute('aria-valuemin'), bottom.getAttribute('aria-valuenow'), bottom.getAttribute('aria-valuemax')],
      ['0', '1', '2'],
    );
    assert.equal(bottom.getAttribute('aria-valuetext'), 'normal height');

    mgr.apply([{ id: 'a', span: 2, size: 'tall', hidden: false }]);
    assert.equal(right.getAttribute('aria-valuenow'), '2');
    assert.equal(bottom.getAttribute('aria-valuenow'), '2');
    assert.equal(bottom.getAttribute('aria-valuetext'), 'tall height');
    assert.equal(corner.getAttribute('aria-valuenow'), '2');
    assert.equal(corner.getAttribute('aria-valuetext'), '2 of 2 columns, tall height');

    // Driven by the keyboard too, not just by host echoes.
    mgr.setMode('resize');
    right.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    assert.equal(right.getAttribute('aria-valuenow'), '1');
    grid.remove();
  });

  it('the column count is read from the grid element (where main.ts sets --wv-cols), not the document root', () => {
    const grid = document.createElement('div');
    grid.style.setProperty('--wv-cols', '3');
    document.body.appendChild(grid);
    const panels = makePanels(['a']);
    const mgr = mountLayout(grid, panels, () => {});
    mgr.apply(baseLayout(['a']));
    const right = panels.a!.querySelector<HTMLElement>('.wv-resize-handle--right')!;
    assert.equal(right.getAttribute('aria-valuemax'), '3');

    mgr.setMode('resize');
    right.click();
    right.click();
    assert.equal(panels.a!.dataset.span, '3', 'can widen to the third column');
    grid.remove();
  });

  it('the icon-only hide button has an accessible name that names the panel and flips with its state', () => {
    const grid = document.createElement('div');
    document.body.appendChild(grid);
    const panels = makePanels(['a']);
    panels.a!.setAttribute('aria-label', 'Daily usage');
    const mgr = mountLayout(grid, panels, () => {});
    mgr.apply(baseLayout(['a']));

    const hide = panels.a!.querySelector<HTMLElement>('[data-act="hide"]')!;
    assert.equal(hide.getAttribute('aria-label'), 'Hide Daily usage');
    assert.equal(hide.querySelector('i')!.getAttribute('aria-hidden'), 'true');
    hide.click();
    assert.equal(hide.getAttribute('aria-label'), 'Show Daily usage');
    hide.click();
    assert.equal(hide.getAttribute('aria-label'), 'Hide Daily usage');
    grid.remove();
  });
});

describe('layout — keyboard reorder (Alt+ArrowUp/Down on a focused panel header)', () => {
  function setup(ids: string[], hidden: string[] = []) {
    const grid = document.createElement('div');
    document.body.appendChild(grid);
    const panels = makePanels(ids);
    for (const id of ids) {
      const header = document.createElement('div');
      header.className = 'wv-chart-header';
      panels[id]!.appendChild(header);
      grid.appendChild(panels[id]!);
    }
    const changes: DashboardLayout[] = [];
    const mgr = mountLayout(grid, panels, (l) => changes.push(l));
    mgr.apply(ids.map((id) => ({ id, span: 1 as const, hidden: hidden.includes(id) })));
    const header = (id: string) => panels[id]!.querySelector<HTMLElement>('.wv-chart-header')!;
    const press = (id: string, key: string, altKey = true) =>
      header(id).dispatchEvent(new window.KeyboardEvent('keydown', { key, altKey, bubbles: true, cancelable: true }));
    return { grid, panels, mgr, changes, header, press };
  }

  it('headers are focusable only in Move mode', () => {
    const { grid, mgr, header } = setup(['a', 'b']);
    assert.equal(header('a').hasAttribute('tabindex'), false);
    mgr.setMode('move');
    assert.equal(header('a').tabIndex, 0);
    assert.equal(header('a').getAttribute('aria-keyshortcuts'), 'Alt+ArrowUp Alt+ArrowDown');
    mgr.setMode('none');
    assert.equal(header('a').hasAttribute('tabindex'), false);
    grid.remove();
  });

  it('Alt+ArrowDown moves the panel down one slot, emits the order, and keeps focus on its header', () => {
    const { grid, mgr, changes, header, press, panels } = setup(['a', 'b', 'c']);
    mgr.setMode('move');
    header('a').focus();
    press('a', 'ArrowDown');

    assert.deepEqual(changes.at(-1)!.map((p) => p.id), ['b', 'a', 'c']);
    assert.deepEqual([...grid.children], [panels.b, panels.a, panels.c], 'DOM follows');
    assert.equal(document.activeElement, header('a'), 'focus returned to the moved panel\'s header');

    press('a', 'ArrowUp');
    assert.deepEqual(changes.at(-1)!.map((p) => p.id), ['a', 'b', 'c']);
    assert.equal(document.activeElement, header('a'));
    grid.remove();
  });

  it('hops over hidden panels so the move is visible', () => {
    const { grid, mgr, changes, header, press } = setup(['a', 'b', 'c'], ['b']);
    mgr.setMode('move');
    header('a').focus();
    press('a', 'ArrowDown');
    assert.deepEqual(changes.at(-1)!.map((p) => p.id), ['b', 'c', 'a']);
    grid.remove();
  });

  it('does nothing at the ends, without Alt, or outside Move mode', () => {
    const { grid, mgr, changes, press } = setup(['a', 'b']);
    press('a', 'ArrowDown'); // not in move mode
    mgr.setMode('move');
    press('a', 'ArrowUp'); // already first
    press('b', 'ArrowDown'); // already last
    press('a', 'ArrowDown', false); // no Alt
    press('a', 'Enter');
    assert.equal(changes.length, 0);
    grid.remove();
  });
});
