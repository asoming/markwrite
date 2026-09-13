/** Platform conventions; browser previews on macOS use the same labels. */
export function macPlatform(platform: string): boolean {
  return /Mac|iPhone|iPad|iPod/i.test(platform);
}
export const isMac = typeof navigator !== 'undefined' && macPlatform(navigator.platform);
export function platformText(text: string): string {
  return isMac
    ? text.replaceAll('Ctrl', '⌘').replaceAll('Alt', '⌥').replaceAll('Shift', '⇧')
    : text;
}
