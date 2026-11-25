/**
 * Calls `cb` once per animation frame after `el`'s size changes (a
 * ResizeObserver, coalesced through requestAnimationFrame). Used to keep each
 * panel's chart sized to its body: gridstack changes a panel's box on a drag
 * resize, a keyboard resize, a column switch and a re-add, and the chart has to
 * follow. An element with no size (a panel taken out of the grid is `hidden`)
 * is skipped: there is nothing to size, and the observer fires again with the
 * real size once it is shown. Returns a function that stops observing.
 */
export function observeResize(el: Element, cb: () => void): () => void {
  let frame: number | undefined;
  const observer = new ResizeObserver((entries) => {
    const { width, height } = entries[entries.length - 1]!.contentRect;
    if (width === 0 || height === 0) return;
    if (frame !== undefined) cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      frame = undefined;
      cb();
    });
  });
  observer.observe(el);
  return () => {
    observer.disconnect();
    if (frame !== undefined) cancelAnimationFrame(frame);
  };
}
