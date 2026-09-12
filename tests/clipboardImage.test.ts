import { beforeEach, expect, it, vi } from 'vitest';
const api = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: api.invoke, isTauri: () => true }));
import {
  nativeClipboardImage,
  htmlClipboardImage,
  normalizeImageFile,
  transferredImage,
} from '../src/lib/clipboardImage';
beforeEach(() => api.invoke.mockReset());
it('normalizes nameless screenshots and clipboard items without a files collection', () => {
  const file = new File(['png'], 'image', { type: 'image/png' });
  const data = {
    files: [],
    items: [{ kind: 'file', getAsFile: () => file }],
  } as unknown as DataTransfer;
  const image = transferredImage(data)!;
  expect(image.name).toBe('image.png');
  expect(image.type).toBe('image/png');
  expect(normalizeImageFile(new File(['jpeg'], 'photo.png', { type: 'image/jpeg' }))?.name).toBe(
    'photo.jpg',
  );
  expect(normalizeImageFile(new File(['x'], 'code.svg', { type: 'image/svg+xml' }))).toBeNull();
});
it('reads native image data only on the explicit call and preserves binary bytes', async () => {
  expect(api.invoke).not.toHaveBeenCalled();
  api.invoke.mockResolvedValue({
    name: 'pasted-image.png',
    mime: 'image/png',
    data: btoa('\x89PNG'),
  });
  const image = await nativeClipboardImage();
  expect(image?.size).toBe(4);
  expect(image?.type).toBe('image/png');
  expect(api.invoke).toHaveBeenCalledExactlyOnceWith('read_clipboard_image');
});

it('extracts image-only HTML while preserving mixed text and remote-image HTML for Markdown conversion', () => {
  expect(htmlClipboardImage('<img src="data:image/png;base64,iVBORw==">')?.name).toBe(
    'pasted-image.png',
  );
  expect(htmlClipboardImage('<p>text<img src="data:image/png;base64,iVBORw=="></p>')).toBeNull();
  expect(htmlClipboardImage('<img src="https://example.com/a.png">')).toBeNull();
});
