import { mathjax } from '@mathjax/src/js/mathjax.js';
import { TeX } from '@mathjax/src/js/input/tex.js';
import { SVG } from '@mathjax/src/js/output/svg.js';
import { liteAdaptor } from '@mathjax/src/js/adaptors/liteAdaptor.js';
import { RegisterHTMLHandler } from '@mathjax/src/js/handlers/html.js';
import '@mathjax/src/js/input/tex/base/BaseConfiguration.js';
import '@mathjax/src/js/input/tex/ams/AmsConfiguration.js';
import '@mathjax/src/js/input/tex/newcommand/NewcommandConfiguration.js';
import '@mathjax/src/js/input/tex/textmacros/TextMacrosConfiguration.js';
import '@mathjax/src/js/input/tex/color/ColorConfiguration.js';

// Bundle the extended glyph paths. Formula export never fetches a CDN or executes
// user-provided TeX packages, and remains available on a disconnected desktop.
import.meta.glob('../../node_modules/@mathjax/mathjax-newcm-font/mjs/svg/dynamic/*.js', {
  eager: true,
});

const adaptor = liteAdaptor();
RegisterHTMLHandler(adaptor);
const renderer = mathjax.document('', {
  InputJax: new TeX({
    packages: ['base', 'ams', 'newcommand', 'textmacros', 'color'],
    formatError(_jax: unknown, error: Error) {
      throw new Error(`公式无法导出：${error.message}`);
    },
  }),
  OutputJax: new SVG({ fontCache: 'none', linebreaks: { inline: false } }),
});

export function formulaSvg(tex: string, display: boolean): string {
  const node = renderer.convert(tex, { display, em: 16, ex: 8, containerWidth: 640 });
  const svg = adaptor.tags(node, 'svg')[0];
  if (!svg) throw new Error('公式没有生成可导出的图形。');
  // Physical units make the same SVG useful in PDF and in Word image runs.
  const viewBox = (adaptor.getAttribute(svg, 'viewBox') || '').split(/[ ,]+/).map(Number);
  if (viewBox.length !== 4 || !viewBox.every(Number.isFinite)) throw new Error('公式尺寸无效。');
  adaptor.setAttribute(svg, 'width', String((viewBox[2] / 1000) * 16));
  adaptor.setAttribute(svg, 'height', String((viewBox[3] / 1000) * 16));
  adaptor.setAttribute(svg, 'color', '#24272e');
  return adaptor.outerHTML(svg);
}
