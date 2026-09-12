import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { observeReadingAssets } from '../src/lib/readingDom';
const { assetData, invoke, hydrate } = vi.hoisted(() => ({
  assetData: vi.fn(),
  invoke: vi.fn(),
  hydrate: vi.fn(),
}));
vi.mock('../src/lib/platform', () => ({ assetData, desktop: true }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('../src/lib/markdown', () => ({ hydrateDiagrams: hydrate }));
class Observer {
  static instances: Observer[] = [];
  observed: Element[] = [];
  constructor(readonly callback: (entries: Partial<IntersectionObserverEntry>[]) => void) {
    Observer.instances.push(this);
  }
  observe(node: Element) {
    this.observed.push(node);
  }
  unobserve() {}
  disconnect() {}
  show(node: Element) {
    this.callback([{ target: node, isIntersecting: true }]);
  }
}
let root: HTMLDivElement, cleanup: (() => void) | undefined;
beforeEach(() => {
  assetData.mockReset();
  invoke.mockReset();
  hydrate.mockReset();
  Observer.instances = [];
  vi.stubGlobal('IntersectionObserver', Observer);
  root = document.createElement('div');
  document.body.append(root);
});
afterEach(() => {
  cleanup?.();
  root.remove();
  vi.unstubAllGlobals();
});
const bind = () => {
  cleanup = observeReadingAssets(
    root,
    root,
    '/文档/note.md',
    { allowedRemote: new Set(), cache: new Map() },
    vi.fn(),
  );
  return Observer.instances.at(-1)!;
};
describe('visible-only reading assets', () => {
  it('does no file I/O or diagram rendering before visibility and never loads a remote image without a click', async () => {
    root.innerHTML =
      '<img data-asset="local.png"><div data-diagram="graph%20LR"></div><img data-asset="https://example.com/private.png">';
    assetData.mockResolvedValue('data:image/png;base64,AAA=');
    const observer = bind(),
      images = root.querySelectorAll('img');
    expect(assetData).not.toHaveBeenCalled();
    expect(hydrate).not.toHaveBeenCalled();
    observer.show(images[0]);
    observer.show(images[0]);
    observer.show(root.querySelector('[data-diagram]')!);
    observer.show(images[1]);
    await Promise.resolve();
    expect(assetData).toHaveBeenCalledTimes(1);
    expect(hydrate).toHaveBeenCalledTimes(1);
    expect(images[1].getAttribute('src')).toBeNull();
    (root.querySelector('.remote-image-load') as HTMLButtonElement).click();
    expect(images[1].getAttribute('src')).toBe('https://example.com/private.png');
  });
  it('offers an explicit attachment-folder grant and retries the same relative image without relocating it', async () => {
    root.innerHTML = '<img data-asset="../图片/例子.png">';
    assetData
      .mockRejectedValueOnce(new Error('unapproved'))
      .mockResolvedValueOnce('data:image/png;base64,AAA=');
    invoke.mockResolvedValue('/图片');
    bind().show(root.querySelector('img')!);
    await vi.waitFor(() => expect(root.querySelector('.local-image-authorize')).not.toBeNull());
    expect(invoke).not.toHaveBeenCalled();
    (root.querySelector('.local-image-authorize') as HTMLButtonElement).click();
    await vi.waitFor(() =>
      expect(root.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,AAA='),
    );
    expect(invoke).toHaveBeenCalledWith('authorize_asset_folder');
    expect(assetData).toHaveBeenLastCalledWith('/文档/note.md', '../图片/例子.png');
    expect(root.querySelector('.local-image-authorize')).toBeNull();
  });
  it('ignores a late asset response after its virtual block has been disposed', async () => {
    let finish!: (source: string) => void;
    root.innerHTML = '<img data-asset="local.png">';
    assetData.mockReturnValue(
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
    );
    bind().show(root.querySelector('img')!);
    cleanup?.();
    finish('data:image/png;base64,AAA=');
    await Promise.resolve();
    expect(root.querySelector('img')?.getAttribute('src')).toBeNull();
  });
});
