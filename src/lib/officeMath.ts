import katex from 'katex';
import { ImportedXmlComponent, Math as OfficeMath, type MathComponent } from 'docx';

/** Convert the same KaTeX MathML used by Markdown into editable Office Math. No remote XSLT. */
export function editableFormula(tex: string, display: boolean): OfficeMath {
  if (tex.length > 20_000)
    throw new Error('公式过长，请选择图片公式导出。 / Formula too long; choose image equations.');
  const template = document.createElement('template');
  template.innerHTML = katex.renderToString(tex, {
    output: 'mathml',
    displayMode: display,
    throwOnError: true,
    trust: false,
    strict: 'ignore',
  });
  const math = template.content.querySelector('math');
  if (!math) throw new Error('Formula did not produce MathML');
  let visited = 0;
  const xml = (
    name: string,
    children: (ImportedXmlComponent | string)[] = [],
    attributes?: Record<string, string>,
  ) => {
    const node = new ImportedXmlComponent(`m:${name}`, attributes);
    children.forEach((child) => node.push(child));
    return node;
  };
  const text = (value: string, variant?: string, plain = false) => {
    const properties: ImportedXmlComponent[] = [];
    if (plain) properties.push(xml('nor'));
    const style =
      variant === 'bold'
        ? 'b'
        : variant === 'bold-italic'
          ? 'bi'
          : variant === 'normal'
            ? 'p'
            : undefined;
    if (style) properties.push(xml('sty', [], { 'm:val': style }));
    const script = (
      {
        'double-struck': 'double-struck',
        script: 'script',
        fraktur: 'fraktur',
        'sans-serif': 'sans-serif',
        monospace: 'monospace',
      } as Record<string, string>
    )[variant || ''];
    if (script) properties.push(xml('scr', [], { 'm:val': script }));
    return xml('r', [
      ...(properties.length ? [xml('rPr', properties)] : []),
      xml('t', [value], { 'xml:space': 'preserve' }),
    ]);
  };
  const group = (name: string, content: ImportedXmlComponent[]) => xml(name, content);
  function convert(node: Element, inheritedVariant?: string): ImportedXmlComponent[] {
    const variant = node.getAttribute('mathvariant') || inheritedVariant;
    if (++visited > 10_000)
      throw new Error('公式节点过多，请选择图片公式。 / Choose image equations for this formula.');
    const children = [...node.children];
    const child = (index: number) => (children[index] ? convert(children[index], variant) : []);
    const all = () => children.flatMap((child) => convert(child, variant));
    switch (node.localName) {
      case 'annotation':
      case 'annotation-xml':
        return [];
      case 'math':
      case 'semantics':
      case 'mrow':
        if (
          children.length >= 2 &&
          children[0].getAttribute('fence') === 'true' &&
          children.at(-1)!.getAttribute('fence') === 'true'
        )
          return [
            xml('d', [
              xml('dPr', [
                xml('begChr', [], { 'm:val': children[0].textContent || '' }),
                xml('endChr', [], { 'm:val': children.at(-1)!.textContent || '' }),
              ]),
              group(
                'e',
                children.slice(1, -1).flatMap((child) => convert(child, variant)),
              ),
            ]),
          ];
        return all();
      case 'mstyle':
      case 'mpadded':
        return all();
      case 'mi':
      case 'mn':
      case 'mo':
      case 'mtext':
      case 'ms':
        return [text(node.textContent || '', variant, ['mtext', 'ms'].includes(node.localName))];
      case 'mspace':
        return [text(' ')];
      case 'mfrac':
        return [xml('f', [group('num', child(0)), group('den', child(1))])];
      case 'msqrt':
        return [
          xml('rad', [
            xml('radPr', [xml('degHide', [], { 'm:val': '1' })]),
            group('deg', []),
            group('e', all()),
          ]),
        ];
      case 'mroot':
        return [xml('rad', [group('deg', child(1)), group('e', child(0))])];
      case 'msub':
        return [xml('sSub', [group('e', child(0)), group('sub', child(1))])];
      case 'msup':
        return [xml('sSup', [group('e', child(0)), group('sup', child(1))])];
      case 'msubsup':
        return [
          xml('sSubSup', [group('e', child(0)), group('sub', child(1)), group('sup', child(2))]),
        ];
      case 'mover': {
        if (node.getAttribute('accent') === 'true')
          return [
            xml('acc', [
              xml('accPr', [xml('chr', [], { 'm:val': children[1]?.textContent || '^' })]),
              group('e', child(0)),
            ]),
          ];
        return [xml('limUpp', [group('e', child(0)), group('lim', child(1))])];
      }
      case 'munder':
        return [xml('limLow', [group('e', child(0)), group('lim', child(1))])];
      case 'munderover':
        return [
          xml('limUpp', [
            group('e', [xml('limLow', [group('e', child(0)), group('lim', child(1))])]),
            group('lim', child(2)),
          ]),
        ];
      case 'mtable':
        return [
          xml(
            'm',
            children.map((row) =>
              xml(
                'mr',
                [...row.children].map((cell) =>
                  group(
                    'e',
                    [...cell.children].flatMap((child) => convert(child, variant)),
                  ),
                ),
              ),
            ),
          ),
        ];
      case 'mfenced':
        return [
          xml('d', [
            xml('dPr', [
              xml('begChr', [], { 'm:val': node.getAttribute('open') || '(' }),
              xml('endChr', [], { 'm:val': node.getAttribute('close') || ')' }),
            ]),
            ...children.map((child) => group('e', convert(child, variant))),
          ]),
        ];
      case 'mphantom':
        return [xml('phant', [group('e', all())])];
      case 'menclose': {
        if (node.getAttribute('notation') === 'box') return [xml('borderBox', [group('e', all())])];
        throw new Error(
          '该公式装饰暂不能转换为 Office 公式，请选择图片公式。 / Choose image equations for this decoration.',
        );
      }
      default:
        throw new Error(
          `无法转换公式节点 ${node.localName}，请选择图片公式。 / Choose image equations for this expression.`,
        );
    }
  }
  return new OfficeMath({ children: convert(math) as MathComponent[] });
}
