/**
 * Escapes text for interpolation into HTML (element content or a quoted
 * attribute). ECharts renders tooltip formatter output as HTML, so every
 * string that reaches a formatter — model ids, repo keys, languages, node
 * names, billing SKUs, currency codes — must pass through here first.
 *
 * Deliberately self-contained (no module-level lookup table, no nested
 * helpers): SidebarView embeds this function's source into its inline
 * webview script via toString(), so the sidebar and the dashboard share one
 * implementation.
 */
export function escapeHtml(value: unknown): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
