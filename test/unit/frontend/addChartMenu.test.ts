import { strict as assert } from 'assert';
import { mountAddChartMenu } from '../../../src/extension-frontend/addChartMenu';

function setup(titles: Array<[string, string]> = [['repos', 'By repository'], ['tokens', 'Tokens over time']]) {
  const wrap = document.createElement('span');
  const button = document.createElement('button');
  button.setAttribute('aria-expanded', 'false');
  const menu = document.createElement('div');
  menu.setAttribute('role', 'menu');
  menu.hidden = true;
  wrap.append(button, menu);
  document.body.appendChild(wrap);
  const picked: string[] = [];
  const handle = mountAddChartMenu({
    wrap, button, menu,
    hiddenPanels: () => titles.map(([id, title]) => ({ id, title })),
    onPick: (id) => picked.push(id),
  });
  const key = (target: HTMLElement, k: string) =>
    target.dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  const items = () => [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')];
  return { wrap, button, menu, picked, handle, key, items };
}

describe('Add chart menu', () => {
  it('opens on click, lists the hidden panels as menu items, and focuses the first', () => {
    const { wrap, button, menu, items } = setup();
    button.click();
    assert.equal(menu.hidden, false);
    assert.equal(button.getAttribute('aria-expanded'), 'true');
    assert.deepEqual(items().map((i) => i.textContent), ['By repository', 'Tokens over time']);
    assert.equal(document.activeElement, items()[0]);
    wrap.remove();
  });

  it('shows an explanatory empty state when every chart is already shown', () => {
    const { wrap, button, menu, items } = setup([]);
    button.click();
    assert.equal(items().length, 0);
    assert.equal(menu.querySelector('.wv-add-chart-empty')!.textContent, 'All charts are already shown');
    wrap.remove();
  });

  it('ArrowDown/ArrowUp move between items, wrapping at both ends; Home/End jump', () => {
    const { wrap, button, menu, key, items } = setup([['a', 'A'], ['b', 'B'], ['c', 'C']]);
    button.click();
    const [a, b, c] = items();
    key(menu, 'ArrowDown');
    assert.equal(document.activeElement, b);
    key(menu, 'ArrowDown');
    assert.equal(document.activeElement, c);
    key(menu, 'ArrowDown');
    assert.equal(document.activeElement, a, 'wraps to the start');
    key(menu, 'ArrowUp');
    assert.equal(document.activeElement, c, 'wraps to the end');
    key(menu, 'Home');
    assert.equal(document.activeElement, a);
    key(menu, 'End');
    assert.equal(document.activeElement, c);
    wrap.remove();
  });

  it('Escape closes the menu and returns focus to the button', () => {
    const { wrap, button, menu, key, items } = setup();
    button.click();
    key(items()[1]!, 'Escape');
    assert.equal(menu.hidden, true);
    assert.equal(button.getAttribute('aria-expanded'), 'false');
    assert.equal(document.activeElement, button);
    wrap.remove();
  });

  it('choosing an item picks it, closes the menu, and returns focus to the button', () => {
    const { wrap, button, menu, picked, items } = setup();
    button.click();
    items()[1]!.click();
    assert.deepEqual(picked, ['tokens']);
    assert.equal(menu.hidden, true);
    assert.equal(document.activeElement, button);
    wrap.remove();
  });

  it('ArrowDown on the closed button opens the menu', () => {
    const { wrap, button, menu, key } = setup();
    button.focus();
    key(button, 'ArrowDown');
    assert.equal(menu.hidden, false);
    wrap.remove();
  });

  it('Tab closes the menu without stealing focus, and a click elsewhere closes it too', () => {
    const { wrap, button, menu, key, items } = setup();
    button.click();
    key(items()[0]!, 'Tab');
    assert.equal(menu.hidden, true);

    button.click();
    assert.equal(menu.hidden, false);
    document.body.click();
    assert.equal(menu.hidden, true);
    assert.equal(button.getAttribute('aria-expanded'), 'false');
    wrap.remove();
  });

  it('clicking the button again closes an open menu', () => {
    const { wrap, button, menu } = setup();
    button.click();
    button.click();
    assert.equal(menu.hidden, true);
    wrap.remove();
  });
});
