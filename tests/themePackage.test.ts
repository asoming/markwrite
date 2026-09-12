import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { compileThemePackage, readThemePackage, type ThemePackage } from '../src/lib/themePackage';
import { compileDocumentTheme } from '../src/lib/themeImport';
const bundle = (files: Record<string, string>): ThemePackage => ({
  styles: Object.keys(files).filter((key) => key.endsWith('.css')),
  read: async (key) => {
    if (!(key in files)) throw new Error('Missing: ' + key);
    return new TextEncoder().encode(files[key]);
  },
});
describe('offline theme packages', () => {
  it('resolves nested imports and Unicode resource paths, preserves media queries and scopes fonts', async () => {
    const css = await compileThemePackage(
      bundle({
        '主题/main.css':
          '@import "css/type.css" screen and (min-width: 600px); #write { background-image:url("图/bg.png"); }',
        '主题/css/type.css':
          '@font-face {font-family: Paper;src:url("../字体/font.woff2")} body {font-family:Paper; color:#321}',
        '主题/字体/font.woff2': 'wOF2',
        '主题/图/bg.png': 'PNG',
      }),
      '主题/main.css',
    );
    expect(css).toContain('screen and (min-width: 600px)');
    expect(css).toContain('data:font/woff2;base64,d09GMg==');
    expect(css).toContain('data:image/png;base64,UE5H');
    const result = compileDocumentTheme(css, 'test-package');
    expect(result.css).toContain('data:font/woff2');
    expect(result.css).not.toContain('@import');
    expect(result.css).toContain('data-custom-document-theme');
  });
  it('rejects missing resources, cycles, escaping paths and expanded size before applying anything', async () => {
    await expect(
      compileThemePackage(bundle({ 'a.css': '@import "a.css";' }), 'a.css'),
    ).rejects.toThrow('Circular');
    await expect(
      compileThemePackage(bundle({ 'a.css': 'p{background:url(../escape.png)}' }), 'a.css'),
    ).rejects.toThrow('escapes');
    await expect(
      compileThemePackage(bundle({ 'a.css': 'p{background:url(missing.png)}' }), 'a.css'),
    ).rejects.toThrow('Missing');
    await expect(
      compileThemePackage(
        bundle({ 'a.css': 'p{background:url(big.png)}', 'big.png': 'a'.repeat(800000) }),
        'a.css',
      ),
    ).rejects.toThrow('size');
    expect(
      await compileThemePackage(
        bundle({ 'a.css': '@import "https://example.invalid/a.css";p{color:red}' }),
        'a.css',
      ),
    ).toBe('p{color:red}');
  });
  it('reads ZIP resources and rejects symlinks and oversized expanded archives', async () => {
    const file = async (zip: JSZip) => {
      const bytes = await zip.generateAsync({ type: 'uint8array', platform: 'UNIX' });
      return { size: bytes.length, arrayBuffer: async () => bytes.buffer } as File;
    };
    const zip = new JSZip();
    zip.file('theme/main.css', '#write{background:url(img.png)}');
    zip.file('theme/img.png', 'PNG');
    const next = await readThemePackage(await file(zip));
    expect(next.styles).toEqual(['theme/main.css']);
    expect(await compileThemePackage(next, next.styles[0])).toContain('data:image/png');
    zip.file('link', '/etc/passwd', { unixPermissions: 0o120777 });
    await expect(readThemePackage(await file(zip))).rejects.toThrow('Invalid package');
    const huge = new JSZip();
    huge.file('huge.bin', new Uint8Array(21 * 1024 * 1024), { compression: 'DEFLATE' });
    huge.file('a.css', 'p{color:red}');
    await expect(readThemePackage(await file(huge))).rejects.toThrow('too large');
  });
});
