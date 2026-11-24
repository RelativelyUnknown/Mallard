/**
 * The "Add chart" picker: a disclosure button plus a menu listing the panels
 * that are currently hidden. Keyboard behaviour follows the WAI-ARIA menu
 * button pattern — ArrowDown/ArrowUp (or Home/End) move between items,
 * Escape closes and returns focus to the button, and choosing an item also
 * returns focus to the button (the item it was on is gone by then).
 */
export interface AddChartItem {
  id: string;
  title: string;
}

export interface AddChartMenuOptions {
  /** Contains both the button and the menu; clicks outside it close the menu. */
  wrap: HTMLElement;
  button: HTMLElement;
  menu: HTMLElement;
  /** Panels that can be added right now. */
  hiddenPanels(): AddChartItem[];
  onPick(id: string): void;
}

export interface AddChartMenuHandle {
  open(): void;
  close(returnFocus?: boolean): void;
}

export function mountAddChartMenu(opts: AddChartMenuOptions): AddChartMenuHandle {
  const { wrap, button, menu } = opts;

  const items = (): HTMLElement[] => [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')];

  function close(returnFocus = false): void {
    const wasOpen = !menu.hidden;
    menu.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    if (returnFocus && wasOpen) button.focus();
  }

  function open(): void {
    menu.innerHTML = '';
    const panels = opts.hiddenPanels();
    if (panels.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'wv-add-chart-empty';
      empty.textContent = 'All charts are already shown';
      menu.appendChild(empty);
    }
    for (const panel of panels) {
      const item = document.createElement('button');
      item.className = 'wv-btn wv-btn--sm wv-add-chart-item';
      item.setAttribute('role', 'menuitem');
      item.textContent = panel.title;
      item.addEventListener('click', () => {
        opts.onPick(panel.id);
        close(true);
      });
      menu.appendChild(item);
    }
    menu.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    items()[0]?.focus();
  }

  button.addEventListener('click', () => {
    if (menu.hidden) open();
    else close();
  });

  button.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' && menu.hidden) {
      e.preventDefault();
      open();
    }
  });

  menu.addEventListener('keydown', (e) => {
    const list = items();
    const idx = list.indexOf(document.activeElement as HTMLElement);
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        list[(idx + 1) % list.length]?.focus();
        break;
      case 'ArrowUp':
        e.preventDefault();
        list[(idx <= 0 ? list.length : idx) - 1]?.focus();
        break;
      case 'Home':
        e.preventDefault();
        list[0]?.focus();
        break;
      case 'End':
        e.preventDefault();
        list[list.length - 1]?.focus();
        break;
      case 'Tab':
        close();
        break;
      default:
        break;
    }
  });

  wrap.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !menu.hidden) {
      e.preventDefault();
      close(true);
    }
  });

  document.addEventListener('click', (e) => {
    if (!wrap.contains(e.target as Node)) close();
  });

  return { open, close };
}
