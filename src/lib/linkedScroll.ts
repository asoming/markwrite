/** Match progress through two independently laid-out documents, without scroll feedback loops. */
export function synchronizeScroll(source: HTMLElement, target: HTMLElement): number {
  const progress = source.scrollTop / Math.max(1, source.scrollHeight - source.clientHeight);
  const top =
    Math.max(0, Math.min(1, progress)) * Math.max(0, target.scrollHeight - target.clientHeight);
  target.scrollTop = top;
  return target.scrollTop;
}
