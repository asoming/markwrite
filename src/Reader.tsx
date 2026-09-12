import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { ArrowDown, ArrowUp, Bookmark, BookMarked, Search, Trash2, X } from 'lucide-react';
import { t, useI18n } from './lib/i18n';
import { sanitizeRenderedMarkdown } from './lib/markdown';
import { markdownConfiguration, type MarkdownParseOptions } from './lib/markdownParser';
import type { Theme } from './lib/types';
import { openImagePreview } from './components/imagePreview';
import {
  findReadingText,
  highlightReadingMatches,
  observeReadingAssets,
  type ReadingAssets,
} from './lib/readingDom';
import {
  ReadingHeights,
  readReadingState,
  saveReadingBookmarks,
  saveReadingLocation,
  type ReadingBookmark,
  type ReadingLocation,
} from './lib/readingState';
import { useReadingDocument } from './lib/useReadingDocument';
import type { ReaderHandle, ReadingBlock, ReadingChunk, ReadingHit } from './lib/readingTypes';
import { prepareReadingClipboard, type ReadingClipboard } from './lib/readingClipboard';
import './editor/directEditing.css';
import './reading.css';
import './codeHighlight.css';
import { highlightCodeBlocks } from './lib/codeHighlight';

export type { ReaderHandle, ReadingLocation };
export type ReaderProps = {
  content: string;
  path?: string;
  documentKey?: string;
  persistPosition?: boolean;
  onLink: (href: string) => void;
  theme?: Theme;
  revision?: number;
  parseOptions?: MarkdownParseOptions;
  onReady?: (handle: ReaderHandle | null) => void;
  onLocationChange?: (location: ReadingLocation) => void;
  onNavigate?: () => void;
};
type Jump = {
  boundary?: 'start' | 'end';
  line?: number;
  point?: ReadingLocation;
  anchor?: string;
  hit?: ReadingHit;
  token: number;
};
type Target = Jump & { index: number };

const Reader = forwardRef<ReaderHandle, ReaderProps>(function Reader(
  {
    content,
    path,
    documentKey,
    persistPosition = true,
    onLink,
    theme,
    revision,
    parseOptions,
    onReady,
    onLocationChange,
    onNavigate,
  },
  forwardedRef,
) {
  const { language } = useI18n();
  const identity = documentKey?.startsWith('compare:') ? documentKey : path || documentKey || '';
  const model = useReadingDocument(
    content,
    identity,
    { ...markdownConfiguration(), ...parseOptions },
    revision,
  );
  const viewport = useRef<HTMLDivElement>(null),
    article = useRef<HTMLElement>(null);
  const previewClose = useRef<(() => void) | null>(null);
  const assets = useRef<ReadingAssets>({ allowedRemote: new Set(), cache: new Map() });
  const [view, setView] = useState({ top: 0, height: 800 });
  const [measureRevision, setMeasureRevision] = useState(0);
  const [searchOpen, setSearchOpen] = useState(false),
    [query, setQuery] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [bookmarksOpen, setBookmarksOpen] = useState(false),
    [bookmarkLimit, setBookmarkLimit] = useState(50);
  const [bookmarks, setBookmarks] = useState<ReadingBookmark[]>(
    () => readReadingState(identity).bookmarks,
  );
  const [storageError, setStorageError] = useState('');
  const [pasteHint, setPasteHint] = useState(false);
  const [allSelected, setAllSelected] = useState(false);
  const [copyState, setCopyState] = useState<'idle' | 'preparing' | 'ready' | 'copied' | 'error'>(
    'idle',
  );
  const copyAll = useRef(false),
    copyEpoch = useRef(0);
  const copyPromise = useRef<Promise<ReadingClipboard> | null>(null),
    copyValue = useRef<ReadingClipboard | null>(null);
  const [jump, setJump] = useState<Jump | null>(null),
    [target, setTarget] = useState<Target | null>(null);
  const [flash, setFlash] = useState<number | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const searchCursor = useRef<{ query: string; caseSensitive: boolean; index: number } | null>(
    null,
  );
  const jumpSerial = useRef(0),
    announced = useRef(false),
    restored = useRef(false),
    pendingBookmark = useRef(false);
  const location = useRef<ReadingLocation | null>(readReadingState(identity).location || null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const scrollFrame = useRef(0),
    previousIdentity = useRef(identity);
  const boundaryIntent = useRef<'start' | 'end' | null>(null);
  const heights = useRef(new ReadingHeights([])),
    lastBlocks = useRef<ReadingBlock[]>([]);
  const currentGeneration = useRef(model.generation);
  if (lastBlocks.current !== model.blocks || currentGeneration.current !== model.generation) {
    const keep = currentGeneration.current === model.generation;
    heights.current = new ReadingHeights(
      model.blocks.map((block, index) =>
        keep ? heights.current.values[index] || block.estimatedHeight : block.estimatedHeight,
      ),
    );
    currentGeneration.current = model.generation;
    lastBlocks.current = model.blocks;
  }
  const padding = () =>
    Number.parseFloat(article.current ? getComputedStyle(article.current).paddingTop : '') || 0;
  const updateView = useCallback(() => {
    const node = viewport.current;
    if (node) setView({ top: node.scrollTop, height: node.clientHeight || 800 });
  }, []);
  const start = model.blocks.length
    ? heights.current.at(Math.max(0, view.top - padding() - 650))
    : 0;
  const end = model.blocks.length
    ? Math.min(
        model.blocks.length,
        heights.current.at(Math.max(0, view.top - padding()) + view.height + 650) + 1,
      )
    : 0;
  const visible = model.blocks.slice(start, end);
  const latest = useRef({ identity, blocks: model.blocks, onLocationChange });
  latest.current = { identity, blocks: model.blocks, onLocationChange };

  const rememberPosition = useCallback(() => {
    const node = viewport.current,
      state = latest.current;
    if (!node || !state.blocks.length || !restored.current) return;
    const top = Math.max(0, node.scrollTop - padding() + 32),
      block = heights.current.at(top),
      metadata = state.blocks[block];
    if (!metadata) return;
    const point = {
      line: metadata.fromLine,
      block,
      offset: Math.max(
        0,
        Math.min(1, (top - heights.current.before(block)) / heights.current.values[block]),
      ),
      quote: metadata.excerpt,
    };
    location.current = point;
    state.onLocationChange?.(point);
    clearTimeout(saveTimer.current);
    if (state.identity && persistPosition)
      saveTimer.current = setTimeout(() => {
        try {
          saveReadingLocation(state.identity, point);
        } catch {
          setStorageError(
            t(
              '阅读位置未能保存。请检查应用存储空间。',
              'Reading position could not be saved. Check app storage.',
            ),
          );
        }
      }, 600);
  }, [persistPosition]);

  useLayoutEffect(() => {
    const state = readReadingState(identity),
      sameFile = previousIdentity.current === identity;
    const point = sameFile ? location.current || state.location : state.location;
    previousIdentity.current = identity;
    location.current = point || null;
    setBookmarks(state.bookmarks);
    setStorageError('');
    setBookmarkLimit(50);
    setQuery('');
    setSearchOpen(false);
    setBookmarksOpen(false);
    setTarget(null);
    assets.current = { allowedRemote: new Set(), cache: new Map() };
    announced.current = false;
    boundaryIntent.current = null;
    restored.current = false;
    pendingBookmark.current = false;
    copyAll.current = false;
    copyEpoch.current++;
    copyPromise.current = null;
    copyValue.current = null;
    setAllSelected(false);
    setCopyState('idle');
    setJump({
      point: point || { line: 1, block: 0, offset: 0, quote: '' },
      token: ++jumpSerial.current,
    });
    return () => {
      clearTimeout(saveTimer.current);
      if (identity && persistPosition && location.current && restored.current) {
        try {
          saveReadingLocation(identity, location.current);
        } catch {
          /* Mounted interactions surface storage failures. */
        }
      }
      previewClose.current?.();
      previewClose.current = null;
      copyEpoch.current++;
    };
  }, [identity, content, revision, persistPosition]);

  useEffect(() => {
    model.requestChunks(visible.map((block) => block.index));
  }, [start, end, model.generation, model.chunks, model.requestChunks]);
  useEffect(() => {
    if (!searchOpen || !model.complete) return;
    searchCursor.current = { query, caseSensitive, index: -1 };
    searchTimer.current = setTimeout(() => {
      searchCursor.current = { query, caseSensitive, index: 0 };
      model.requestSearch(query, 0, caseSensitive);
    }, 120);
    return () => clearTimeout(searchTimer.current);
  }, [query, caseSensitive, searchOpen, model.complete, model.generation, model.requestSearch]);
  useEffect(() => {
    if (model.search.hit) {
      searchCursor.current = {
        query: model.search.query,
        caseSensitive,
        index: model.search.index,
      };
      setJump({ hit: model.search.hit, token: ++jumpSerial.current });
    }
  }, [model.search]);
  useEffect(() => {
    if (searchOpen) {
      searchInput.current?.focus();
      searchInput.current?.select();
    }
  }, [searchOpen]);
  useEffect(() => {
    const node = viewport.current;
    if (!node) return;
    const changed = () => {
      cancelAnimationFrame(scrollFrame.current);
      scrollFrame.current = requestAnimationFrame(() => {
        updateView();
        rememberPosition();
      });
    };
    node.addEventListener('scroll', changed, { passive: true });
    const observer =
      typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(updateView);
    observer?.observe(node);
    updateView();
    return () => {
      node.removeEventListener('scroll', changed);
      observer?.disconnect();
      cancelAnimationFrame(scrollFrame.current);
    };
  }, [updateView, rememberPosition]);

  useLayoutEffect(() => {
    if (!jump || !model.blocks.length) return;
    if (!jump.boundary) boundaryIntent.current = null;
    let index = -1;
    if (jump.boundary) {
      if (jump.boundary === 'end' && !model.complete) return;
      index = jump.boundary === 'end' ? model.blocks.length - 1 : 0;
    } else if (jump.hit) index = jump.hit.block;
    else if (jump.anchor)
      index = model.blocks.findIndex((block) => block.anchors.includes(jump.anchor!));
    else {
      const line = Math.max(1, jump.point?.line || jump.line || 1);
      if (!model.complete && line > Math.max(...model.blocks.map((block) => block.toLine))) return;
      if (jump.point?.quote) {
        const quote = jump.point.quote.slice(0, 100),
          matches = model.blocks.filter((block) => block.excerpt.includes(quote));
        if (matches.length)
          index = matches.reduce((a, b) =>
            Math.abs(a.fromLine - line) <= Math.abs(b.fromLine - line) ? a : b,
          ).index;
      }
      if (index < 0)
        index = model.blocks.findIndex((block) => block.fromLine <= line && block.toLine >= line);
      if (index < 0)
        index = model.blocks.reduce(
          (best, block) =>
            Math.abs(block.fromLine - line) < Math.abs(model.blocks[best].fromLine - line)
              ? block.index
              : best,
          0,
        );
    }
    if (index < 0 || index >= model.blocks.length) {
      if (model.complete) {
        setJump(null);
        restored.current = true;
      }
      return;
    }
    restored.current = false;
    if (viewport.current)
      viewport.current.scrollTop =
        padding() +
        heights.current.before(index) +
        (jump.point?.offset || 0) * heights.current.values[index] -
        (jump.point ? 32 : 0);
    updateView();
    model.requestChunks([index]);
    setTarget({ ...jump, index });
    setJump(null);
  }, [jump, model.blocks, model.complete, updateView, model.requestChunks]);

  // Lazy images and newly measured blocks can change the document height after
  // a boundary jump. Keep the requested edge visible until the user navigates.
  useLayoutEffect(() => {
    const node = viewport.current;
    if (!node || !model.complete || !boundaryIntent.current) return;
    node.scrollTop = boundaryIntent.current === 'end' ? node.scrollHeight : 0;
    updateView();
  }, [measureRevision, model.chunks, model.complete, updateView]);

  const cancelBoundary = () => {
    if (!boundaryIntent.current) return;
    boundaryIntent.current = null;
    setJump((current) => (current?.boundary ? null : current));
    setTarget((current) => (current?.boundary ? null : current));
  };

  useLayoutEffect(() => {
    if (!target || !model.chunks.has(target.index)) return;
    const block = article.current?.querySelector<HTMLElement>(
        `[data-reading-block="${target.index}"]`,
      ),
      scroll = viewport.current;
    if (!block || !scroll || !block.querySelector('.reading-block-content')) return;
    let top = block.getBoundingClientRect().top;
    if (target.anchor) {
      const anchor = [...block.querySelectorAll<HTMLElement>('[id]')].find(
        (node) => node.id === target.anchor,
      );
      if (anchor) top = anchor.getBoundingClientRect().top;
    } else if (target.hit) {
      const mark = block.querySelector<HTMLElement>('mark.reading-match.active');
      if (mark) top = mark.getBoundingClientRect().top;
    } else if (target.point) top += target.point.offset * block.getBoundingClientRect().height;
    else if (target.line) {
      const metadata = model.blocks[target.index],
        chunk = model.chunks.get(target.index)!;
      const raw = chunk.source.split('\n')[Math.max(0, target.line - metadata.fromLine)] || '';
      const phrase = raw
        .replace(/^\s*(?:>\s*|#{1,6}\s+|[-*+]\s+|\d+[.)]\s+)/, '')
        .replace(/[*_`]/g, '')
        .trim();
      const range = findReadingText(block, phrase);
      if (range && typeof range.getBoundingClientRect === 'function')
        top = range.getBoundingClientRect().top;
      else
        top +=
          Math.max(
            0,
            Math.min(
              1,
              (target.line - metadata.fromLine) /
                Math.max(1, metadata.toLine - metadata.fromLine + 1),
            ),
          ) * block.getBoundingClientRect().height;
    }
    if (target.boundary === 'end') scroll.scrollTop = scroll.scrollHeight;
    else if (
      target.boundary === 'start' ||
      (target.point && target.index === 0 && target.point.offset === 0)
    )
      scroll.scrollTop = 0;
    else scroll.scrollTop += top - scroll.getBoundingClientRect().top - (target.point ? 32 : 24);
    setFlash(target.point ? null : target.index);
    setTarget(null);
    restored.current = true;
    updateView();
    rememberPosition();
  }, [
    target,
    model.chunks,
    start,
    end,
    measureRevision,
    model.blocks,
    model.search,
    rememberPosition,
    updateView,
  ]);
  useEffect(() => {
    if (flash === null) return;
    const timer = setTimeout(() => setFlash(null), 1600);
    return () => clearTimeout(timer);
  }, [flash]);

  const measured = useCallback(
    (index: number, height: number) => {
      if (height <= 0) return;
      const oldEnd = heights.current.before(index + 1),
        delta = heights.current.update(index, height);
      if (Math.abs(delta) < 0.5) return;
      const node = viewport.current;
      if (node && oldEnd + padding() <= node.scrollTop && !target) node.scrollTop += delta;
      setMeasureRevision((value) => value + 1);
      updateView();
    },
    [target, updateView],
  );
  const preview = useCallback((image: HTMLImageElement) => {
    previewClose.current?.();
    previewClose.current = openImagePreview(image);
  }, []);
  const clearFullSelection = () => {
    if (!copyAll.current) return;
    copyAll.current = false;
    copyEpoch.current++;
    copyPromise.current = null;
    copyValue.current = null;
    setAllSelected(false);
    setCopyState('idle');
  };
  const ensureClipboard = () => {
    if (copyPromise.current) return copyPromise.current;
    const epoch = copyEpoch.current;
    setCopyState('preparing');
    const promise = model
      .requestCopy()
      .then((parts) => prepareReadingClipboard(parts, () => epoch !== copyEpoch.current));
    copyPromise.current = promise;
    void promise
      .then((value) => {
        if (epoch !== copyEpoch.current) return;
        copyValue.current = value;
        setCopyState('ready');
      })
      .catch((error) => {
        if (epoch === copyEpoch.current && error?.name !== 'AbortError') {
          copyPromise.current = null;
          setCopyState('error');
        }
      });
    return promise;
  };
  const selectVisibleText = () => {
    viewport.current?.focus({ preventScroll: true });
    if (!article.current) return;
    const range = document.createRange();
    range.selectNodeContents(article.current);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  };
  const copyPrepared = () => {
    if (!copyValue.current) {
      void ensureClipboard();
      return;
    }
    selectVisibleText();
    // This produces a synchronous copy event while still inside the user's button gesture.
    if (typeof document.execCommand !== 'function' || !document.execCommand('copy'))
      setCopyState('ready');
  };
  const copyDocument = (event: { preventDefault(): void; clipboardData: DataTransfer | null }) => {
    if (!copyAll.current) return;
    event.preventDefault();
    if (copyValue.current && event.clipboardData) {
      event.clipboardData.setData('text/plain', copyValue.current.text);
      event.clipboardData.setData('text/html', copyValue.current.html);
      setCopyState('copied');
      return;
    }
    const epoch = copyEpoch.current,
      prepared = ensureClipboard();
    if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
      try {
        const item = new ClipboardItem({
          'text/plain': prepared.then((value) => new Blob([value.text], { type: 'text/plain' })),
          'text/html': prepared.then((value) => new Blob([value.html], { type: 'text/html' })),
        });
        void navigator.clipboard
          .write([item])
          .then(() => {
            if (epoch === copyEpoch.current) setCopyState('copied');
          })
          .catch(() => {
            if (epoch === copyEpoch.current) setCopyState(copyValue.current ? 'ready' : 'error');
          });
        return;
      } catch {
        /* WebKit versions without promised ClipboardItems use a synchronous retry. */
      }
    }
    void prepared
      .then(() => {
        if (epoch === copyEpoch.current) copyPrepared();
      })
      .catch(() => {});
  };
  const copyEvent = useRef(copyDocument);
  copyEvent.current = copyDocument;
  useEffect(() => {
    const copy = (event: ClipboardEvent) => {
      if (event.defaultPrevented || !copyAll.current) return;
      const anchor = window.getSelection()?.anchorNode;
      if (anchor && !article.current?.contains(anchor)) return;
      copyEvent.current(event);
    };
    document.addEventListener('copy', copy);
    return () => document.removeEventListener('copy', copy);
  }, []);
  const storeBookmarks = (next: ReadingBookmark[]) => {
    if (identity) {
      try {
        saveReadingBookmarks(identity, next);
        setStorageError('');
      } catch {
        setStorageError(
          t(
            '书签未能保存。请检查应用存储空间。',
            'Bookmarks could not be saved. Check app storage.',
          ),
        );
        return;
      }
    }
    setBookmarks(next);
  };
  const resolvedBookmarks = useMemo(() => {
    const result = new Map<number, ReadingBookmark>();
    for (const bookmark of bookmarks) {
      const matches = model.blocks.filter((block) =>
        bookmark.quote ? bookmark.quote === block.excerpt : bookmark.line === block.fromLine,
      );
      if (matches.length) {
        const block = matches.reduce((a, b) =>
          Math.abs(a.fromLine - bookmark.line) <= Math.abs(b.fromLine - bookmark.line) ? a : b,
        );
        result.set(block.index, bookmark);
      }
    }
    return result;
  }, [bookmarks, model.blocks]);
  const bookmarkAt = (index: number) => resolvedBookmarks.get(index);
  const toggleAt = (index: number) => {
    const block = model.blocks[index];
    if (!block) return;
    const existing = bookmarkAt(index);
    storeBookmarks(
      existing
        ? bookmarks.filter((item) => item.id !== existing.id)
        : [
            ...bookmarks,
            {
              line: block.fromLine,
              block: index,
              offset: 0,
              quote: block.excerpt,
              id: crypto.randomUUID(),
              createdAt: Date.now(),
            },
          ],
    );
  };
  useEffect(() => {
    if (!pendingBookmark.current || !model.blocks.length || !restored.current || jump || target)
      return;
    pendingBookmark.current = false;
    toggleAt(heights.current.at(Math.max(0, (viewport.current?.scrollTop || 0) - padding() + 32)));
  }, [model.blocks, model.chunks, jump, target]);
  const actions = useRef<ReaderHandle>(null!);
  actions.current = {
    selectAll() {
      copyAll.current = true;
      setAllSelected(true);
      selectVisibleText();
      void ensureClipboard();
    },
    openSearch(value) {
      clearFullSelection();
      setSearchOpen(true);
      setBookmarksOpen(false);
      if (value !== undefined) setQuery(value);
      else {
        const selected = window.getSelection()?.toString();
        if (selected && selected.length < 500) setQuery(selected);
      }
      searchInput.current?.focus();
    },
    closeSearch() {
      setSearchOpen(false);
      setQuery('');
      model.requestSearch('');
      viewport.current?.focus({ preventScroll: true });
    },
    findNext(direction = 1) {
      clearFullSelection();
      if (!searchOpen) setSearchOpen(true);
      if (!query) return;
      clearTimeout(searchTimer.current);
      const cursor = searchCursor.current;
      const previous =
        cursor?.query === query && cursor.caseSensitive === caseSensitive ? cursor.index : -1;
      const index = (previous >= 0 ? previous : direction === 1 ? -1 : 0) + direction;
      searchCursor.current = { query, caseSensitive, index };
      model.requestSearch(query, index, caseSensitive);
    },
    jumpToLine(line) {
      if (Number.isFinite(line))
        setJump({ line: Math.max(1, Math.floor(line)), token: ++jumpSerial.current });
    },
    jumpToAnchor(anchor) {
      setJump({ anchor: anchor.replace(/^#/, ''), token: ++jumpSerial.current });
    },
    getLocation() {
      return location.current;
    },
    restoreLocation(point) {
      setJump({ point, token: ++jumpSerial.current });
    },
    toggleBookmark() {
      if (!model.blocks.length || !restored.current) {
        pendingBookmark.current = !pendingBookmark.current;
        return;
      }
      toggleAt(
        heights.current.at(Math.max(0, (viewport.current?.scrollTop || 0) - padding() + 32)),
      );
    },
    openBookmarks() {
      setBookmarksOpen(true);
      setSearchOpen(false);
      setBookmarkLimit(50);
    },
  };
  const handle = useMemo<ReaderHandle>(
    () => ({
      selectAll: () => actions.current.selectAll(),
      openSearch: (value) => actions.current.openSearch(value),
      closeSearch: () => actions.current.closeSearch(),
      findNext: (direction) => actions.current.findNext(direction),
      jumpToLine: (line) => actions.current.jumpToLine(line),
      jumpToAnchor: (id) => actions.current.jumpToAnchor(id),
      getLocation: () => actions.current.getLocation(),
      restoreLocation: (point) => actions.current.restoreLocation(point),
      toggleBookmark: () => actions.current.toggleBookmark(),
      openBookmarks: () => actions.current.openBookmarks(),
    }),
    [],
  );
  useImperativeHandle(forwardedRef, () => handle, [handle]);
  const readyCallback = useRef(onReady);
  readyCallback.current = onReady;
  useEffect(() => {
    const callback = readyCallback.current;
    callback?.(handle);
    return () => callback?.(null);
  }, [identity, handle]);
  useLayoutEffect(() => {
    if (announced.current || !article.current?.querySelector('.reading-block-content')) return;
    announced.current = true;
    window.dispatchEvent(
      new CustomEvent('markwrite-reader-ready', {
        detail: { path, documentKey, complete: model.complete },
      }),
    );
  }, [model.chunks, path, documentKey, model.complete]);

  let preceding = model.search.counts.slice(0, start).reduce((sum, count) => sum + count, 0);
  return (
    <div
      className={`reading-shell${allSelected ? ' reading-all-selected' : ''}`}
      data-reading-language={language}
    >
      {searchOpen && (
        <form
          className="reading-find"
          role="search"
          aria-label={t('在阅读内容中查找', 'Find in reading view')}
          onSubmit={(event) => {
            event.preventDefault();
            actions.current.findNext(1);
          }}
        >
          <Search size={16} aria-hidden="true" />
          <input
            ref={searchInput}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('查找正文', 'Find in document')}
            aria-label={t('查找正文', 'Find in document')}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                actions.current.closeSearch();
              } else if (event.key === 'Enter') {
                event.preventDefault();
                event.stopPropagation();
                actions.current.findNext(event.shiftKey ? -1 : 1);
              }
            }}
          />
          <span className="reading-find-count" role="status" aria-live="polite">
            {model.searching
              ? '…'
              : query
                ? `${model.search.total ? model.search.index + 1 : 0} / ${model.search.total}`
                : ''}
          </span>
          <button
            type="button"
            className={caseSensitive ? 'active' : ''}
            aria-pressed={caseSensitive}
            aria-label={t('区分大小写', 'Match case')}
            title={t('区分大小写', 'Match case')}
            onClick={() => setCaseSensitive((value) => !value)}
          >
            Aa
          </button>
          <button
            type="button"
            disabled={!model.search.total}
            aria-label={t('上一个匹配', 'Previous match')}
            title={t('上一个匹配', 'Previous match')}
            onClick={() => actions.current.findNext(-1)}
          >
            <ArrowUp size={16} />
          </button>
          <button
            type="button"
            disabled={!model.search.total}
            aria-label={t('下一个匹配', 'Next match')}
            title={t('下一个匹配', 'Next match')}
            onClick={() => actions.current.findNext(1)}
          >
            <ArrowDown size={16} />
          </button>
          <button
            type="button"
            aria-label={t('关闭查找', 'Close search')}
            onClick={() => actions.current.closeSearch()}
          >
            <X size={16} />
          </button>
        </form>
      )}
      {bookmarksOpen && (
        <aside
          className="reading-bookmarks"
          aria-label={t('段落书签', 'Paragraph bookmarks')}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation();
              setBookmarksOpen(false);
              viewport.current?.focus();
            }
          }}
        >
          <header>
            <BookMarked size={16} />
            <strong>{t('段落书签', 'Paragraph bookmarks')}</strong>
            <button
              type="button"
              aria-label={t('关闭书签', 'Close bookmarks')}
              onClick={() => setBookmarksOpen(false)}
            >
              <X size={16} />
            </button>
          </header>
          {bookmarks.length === 0 ? (
            <p>
              {t(
                '将鼠标放在段落左侧，点击书签即可收藏。',
                'Hover beside a paragraph and click its bookmark to keep your place.',
              )}
            </p>
          ) : (
            <div className="reading-bookmark-list">
              {bookmarks.slice(0, bookmarkLimit).map((bookmark) => (
                <div className="reading-bookmark-row" key={bookmark.id}>
                  <button
                    type="button"
                    onClick={() => {
                      onNavigate?.();
                      actions.current.restoreLocation(bookmark);
                      setBookmarksOpen(false);
                    }}
                  >
                    <span>{bookmark.quote || t('已标记的段落', 'Bookmarked paragraph')}</span>
                    <small>{t('第 {0} 行', 'Line {0}', [bookmark.line])}</small>
                  </button>
                  <button
                    type="button"
                    aria-label={t('删除书签：{0}', 'Remove bookmark: {0}', [bookmark.quote])}
                    onClick={() =>
                      storeBookmarks(bookmarks.filter((item) => item.id !== bookmark.id))
                    }
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}
          {bookmarks.length > bookmarkLimit && (
            <button
              type="button"
              className="reading-show-more"
              onClick={() => setBookmarkLimit((limit) => limit + 50)}
            >
              {t('显示更多', 'Show more')}
            </button>
          )}
        </aside>
      )}
      {storageError && (
        <div className="reading-storage-error" role="alert">
          {storageError}
        </div>
      )}
      {allSelected && copyState !== 'idle' && (
        <div className="reading-copy-status" role="status">
          <span>
            {copyState === 'preparing'
              ? t(
                  '已选择全文，正在准备完整复制…',
                  'Entire document selected. Preparing a complete copy…',
                )
              : copyState === 'copied'
                ? t('已复制全文', 'Entire document copied')
                : copyState === 'error'
                  ? t(
                      '全文复制未完成，点击重试。',
                      'The full copy was not completed. Click to retry.',
                    )
                  : t(
                      '全文已准备，按 Ctrl+C 或点击复制。',
                      'Entire document ready. Press Ctrl+C or click Copy.',
                    )}
          </span>
          {copyState !== 'preparing' && copyState !== 'copied' && (
            <button
              type="button"
              onMouseDown={(event) => event.preventDefault()}
              onClick={copyPrepared}
            >
              {t('复制全文', 'Copy entire document')}
            </button>
          )}
        </div>
      )}
      {pasteHint && (
        <div className="reading-storage-error" role="status">
          {t(
            '当前为阅读模式。请先切换“编辑”或“源码”，再粘贴图片或文字。',
            'Reading mode is read-only. Switch to Edit or Source before pasting images or text.',
          )}
          <button onClick={() => setPasteHint(false)} aria-label={t('关闭', 'Close')}>
            ×
          </button>
        </div>
      )}
      <div
        className="reader-scroll"
        ref={viewport}
        tabIndex={0}
        aria-label={t('文档阅读区域', 'Document reading area')}
        onMouseDown={(event) => {
          cancelBoundary();
          if (event.button === 0) clearFullSelection();
        }}
        onWheel={cancelBoundary}
        onTouchStart={cancelBoundary}
        onCopy={copyDocument}
        onPaste={(event) => {
          event.preventDefault();
          setPasteHint(true);
        }}
        onKeyDown={(event) => {
          if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'v') {
            event.preventDefault();
            setPasteHint(true);
            return;
          }
          if (
            (event.key === 'Home' || event.key === 'End') &&
            !event.shiftKey &&
            !event.altKey &&
            !event.nativeEvent.isComposing
          ) {
            event.preventDefault();
            event.stopPropagation();
            clearFullSelection();
            boundaryIntent.current = event.key === 'Home' ? 'start' : 'end';
            setJump({
              boundary: event.key === 'Home' ? 'start' : 'end',
              token: ++jumpSerial.current,
            });
          } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
            cancelBoundary();
            event.preventDefault();
            event.stopPropagation();
            actions.current.selectAll();
          } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
            event.preventDefault();
            event.stopPropagation();
            actions.current.openSearch();
          } else if (event.key === 'F3') {
            event.preventDefault();
            event.stopPropagation();
            actions.current.findNext(event.shiftKey ? -1 : 1);
          } else if (
            !['Control', 'Meta', 'Shift', 'Alt'].includes(event.key) &&
            !((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c')
          ) {
            cancelBoundary();
            clearFullSelection();
          }
        }}
      >
        <article
          className="markdown-body reader"
          ref={article}
          aria-busy={!model.complete}
          onClick={(event) => {
            const image = (event.target as HTMLElement).closest('img');
            if (image && !image.closest('a')) {
              event.preventDefault();
              preview(image);
              return;
            }
            const anchor = (event.target as HTMLElement).closest('a');
            if (!anchor) return;
            event.preventDefault();
            const href = anchor.getAttribute('href') || '';
            if (href.startsWith('#wiki:')) onLink(href);
            else if (href.startsWith('#')) {
              try {
                onNavigate?.();
                actions.current.jumpToAnchor(decodeURIComponent(href.slice(1)));
              } catch {
                /* Invalid anchors are inert. */
              }
            } else onLink(href);
          }}
        >
          <div
            className="reading-space"
            aria-hidden="true"
            style={{ height: heights.current.before(start) }}
          />
          {visible.map((block) => {
            const active =
              model.search.hit?.block === block.index ? model.search.index - preceding : -1;
            preceding += model.search.counts[block.index] || 0;
            return (
              <ReaderBlock
                key={`${model.generation}:${block.index}`}
                block={block}
                placeholderHeight={heights.current.values[block.index]}
                chunk={model.chunks.get(block.index)}
                viewport={viewport.current}
                path={path}
                theme={theme}
                language={language}
                assets={assets.current}
                preview={preview}
                measured={measured}
                query={searchOpen ? model.search.query : ''}
                active={active}
                caseSensitive={caseSensitive}
                flash={flash === block.index}
                bookmarked={!!bookmarkAt(block.index)}
                onBookmark={() => toggleAt(block.index)}
              />
            );
          })}
          <div
            className="reading-space"
            aria-hidden="true"
            style={{ height: Math.max(0, heights.current.total - heights.current.before(end)) }}
          />
          {model.error ? (
            <p className="reading-error" role="alert">
              {model.error}
            </p>
          ) : (
            !model.complete && (
              <p className="reading-loading" role="status">
                {t('正在打开文档…', 'Opening document…')}
              </p>
            )
          )}
        </article>
      </div>
    </div>
  );
});
export default Reader;

function ReaderBlock({
  block,
  placeholderHeight,
  chunk,
  viewport,
  path,
  theme,
  language,
  assets,
  preview,
  measured,
  query,
  active,
  caseSensitive,
  flash,
  bookmarked,
  onBookmark,
}: {
  block: ReadingBlock;
  placeholderHeight: number;
  chunk?: ReadingChunk;
  viewport: HTMLElement | null;
  path?: string;
  theme?: Theme;
  language: string;
  assets: ReadingAssets;
  preview: (image: HTMLImageElement) => void;
  measured: (index: number, height: number) => void;
  query: string;
  active: number;
  caseSensitive: boolean;
  flash: boolean;
  bookmarked: boolean;
  onBookmark: () => void;
}) {
  const root = useRef<HTMLDivElement>(null),
    body = useRef<HTMLDivElement>(null);
  const originalHtml = useMemo(
    () => (chunk ? sanitizeRenderedMarkdown(chunk.html, { preserveHeadingIds: true }) : ''),
    [chunk],
  );
  const [colored, setColored] = useState<{ source: string; html: string }>();
  useEffect(() => {
    if (!originalHtml.includes('language-')) return;
    let cancelled = false;
    const container = document.createElement('div');
    container.innerHTML = originalHtml;
    void highlightCodeBlocks(container).then(() => {
      if (!cancelled && container.innerHTML !== originalHtml)
        setColored({ source: originalHtml, html: container.innerHTML });
    });
    return () => {
      cancelled = true;
    };
  }, [originalHtml]);
  const html = colored?.source === originalHtml ? colored.html : originalHtml;
  useLayoutEffect(() => {
    if (body.current) highlightReadingMatches(body.current, query, active, caseSensitive);
  }, [html, query, active, caseSensitive]);
  useEffect(() => {
    if (body.current && viewport)
      return observeReadingAssets(body.current, viewport, path, assets, preview);
  }, [html, viewport, path, theme, language, assets, preview]);
  useLayoutEffect(() => {
    const node = root.current;
    if (!node || !chunk) return;
    const measure = () => measured(block.index, node.getBoundingClientRect().height);
    measure();
    const observer =
      typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure);
    observer?.observe(node);
    return () => observer?.disconnect();
  }, [block.index, chunk, measured]);
  return (
    <div
      ref={root}
      className={`reading-block${flash ? ' reading-jump' : ''}`}
      data-reading-block={block.index}
      data-line={block.fromLine}
      style={!chunk ? { height: placeholderHeight } : undefined}
    >
      {chunk && (
        <>
          <div
            className="reading-block-content"
            ref={body}
            dangerouslySetInnerHTML={{ __html: html }}
          />
          <button
            type="button"
            className={`reading-paragraph-bookmark${bookmarked ? ' saved' : ''}`}
            aria-label={
              bookmarked
                ? t('移除此段书签', 'Remove paragraph bookmark')
                : t('收藏此段', 'Bookmark paragraph')
            }
            aria-pressed={bookmarked}
            title={
              bookmarked
                ? t('移除此段书签', 'Remove paragraph bookmark')
                : t('收藏此段', 'Bookmark paragraph')
            }
            onClick={onBookmark}
          >
            <Bookmark size={14} fill={bookmarked ? 'currentColor' : 'none'} />
          </button>
        </>
      )}
    </div>
  );
}
