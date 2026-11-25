/**
 * Markup of one dashboard panel, as a gridstack widget. The `<section>` IS the
 * widget's content element (`grid-stack-item-content`), keeps its accessible
 * name, and holds a `role="img"` chart body described by a screen-reader-only
 * paragraph that main.ts fills from the snapshot (srDescriptions.ts).
 *
 * The header is gridstack's pointer drag handle. Its two controls only exist
 * while the grid is being edited (CSS hides them otherwise, which also keeps
 * them out of the tab order):
 *  - the grip (`data-act="move"`) is the keyboard focus target for lift mode
 *    (keyboard.ts) and carries its roledescription, shortcuts and a pointer to
 *    the visible hint;
 *  - the hide button (`data-act="hide"`), whose label flips between "Hide X"
 *    and "Show X" with the panel's state (dashboardGrid.ts).
 */
import type { ChartDef } from './charts/registry';
import { escapeHtml } from './escapeHtml';

/** The id of the hint paragraph every grip points at through aria-describedby. */
export const LAYOUT_HINT_ID = 'wv-layout-hint';

export function panelItemHtml(d: Pick<ChartDef, 'id' | 'icon' | 'title' | 'bodyId' | 'ariaLabel'>): string {
  const title = escapeHtml(d.title);
  const descId = `desc-${d.bodyId}`;
  return `
    <div class="grid-stack-item" gs-id="${d.id}">
      <section class="wv-chart-section grid-stack-item-content" data-panel="${d.id}" aria-label="${title}">
        <div class="wv-panel-header">
          <span class="wv-chart-title"><i class="codicon ${d.icon}" aria-hidden="true"></i> ${title}</span>
          <span class="wv-panel-tools">
            <button type="button" class="wv-panel-btn wv-panel-grip" data-act="move" aria-label="Move ${title}"
              aria-roledescription="movable panel" aria-describedby="${LAYOUT_HINT_ID}" aria-keyshortcuts="Space Enter"
              aria-pressed="false"><i class="codicon codicon-gripper" aria-hidden="true"></i></button>
            <button type="button" class="wv-panel-btn wv-panel-hide" data-act="hide" aria-label="Hide ${title}"
              title="Hide ${title}"><i class="codicon codicon-eye" aria-hidden="true"></i></button>
          </span>
        </div>
        <p id="${descId}" class="wv-sr-only"></p>
        <div class="wv-chart-body" id="${d.bodyId}" role="img" aria-label="${escapeHtml(d.ariaLabel)}" aria-describedby="${descId}"></div>
      </section>
    </div>`;
}

/** Find the rendered `.grid-stack-item` of every panel and collect the titles by id. */
export function collectPanels(
  defs: ReadonlyArray<Pick<ChartDef, 'id' | 'title'>>,
  root: ParentNode,
): { items: Record<string, HTMLElement>; titles: Record<string, string> } {
  return {
    items: Object.fromEntries(defs.map((d) => [d.id, root.querySelector<HTMLElement>(`[gs-id="${d.id}"]`)!])),
    titles: Object.fromEntries(defs.map((d) => [d.id, d.title])),
  };
}
