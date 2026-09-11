# Export fonts

`NotoSansCJKsc-Regular.otf` and `NotoSansCJKsc-Bold.otf` are the Simplified Chinese
faces from Noto Sans CJK 2.004, distributed under the SIL Open Font License 1.1 in
`OFL.txt`. Copyright notices and font metadata are retained.

Upstream: https://github.com/notofonts/noto-cjk/tree/main/Sans

These copies were extracted without changing glyphs, names, or character coverage
from the `NotoSansCJK-Regular.ttc` and `NotoSansCJK-Bold.ttc` files distributed by
Ubuntu's `fonts-noto-cjk` package, using FontTools `TTCollection` and selecting the
`NotoSansCJKsc` face. Keeping both weights ensures that offline PDF output can
display Chinese and preserve bold text without relying on system fonts. PDF
output embeds only the used glyphs; the application ships the complete fonts.

The font license applies to these font files only, not to documents exported with
them. This directory does not install fonts on the user's operating system.
