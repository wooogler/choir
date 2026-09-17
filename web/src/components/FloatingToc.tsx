import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { useT } from '../i18n';
import type { TocItem } from '../types';
import { scrollToAnchor } from '../utils/docs';
import type { InlineSegment } from '../utils/inline-markdown';

type FloatingTocProps = {
  activeSlug: string;
  items: TocItem[];
};

/**
 * How long the outline stays up after the pointer leaves it.
 *
 * Hover alone closes the moment the pointer clips a corner on its way to a row,
 * which is most of a second's work thrown away; this gives it back.
 */
const CLOSE_GRACE_MS = 320;

function renderSegments(segments: InlineSegment[], keyPrefix: string) {
  // Runs are keyed by their offset in the heading, which is stable and unique
  // without reaching for the array index.
  let offset = 0;
  return segments.map((segment) => {
    const key = `${keyPrefix}-${offset}`;
    offset += segment.text.length;

    let node: ReactNode = segment.text;
    if (segment.code) node = <code>{node}</code>;
    if (segment.italic) node = <em>{node}</em>;
    if (segment.bold) node = <strong>{node}</strong>;
    if (segment.strike) node = <del>{node}</del>;
    return <span key={key}>{node}</span>;
  });
}

export function FloatingToc({ activeSlug, items }: FloatingTocProps) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const closeTimer = useRef<number | null>(null);

  const cancelClose = useCallback(() => {
    if (closeTimer.current === null) return;
    window.clearTimeout(closeTimer.current);
    closeTimer.current = null;
  }, []);

  // Entering anywhere in the rail — a marker, the panel, the space between them
  // — holds it open; leaving starts the grace period rather than closing.
  const hold = useCallback(() => {
    cancelClose();
    setOpen(true);
  }, [cancelClose]);

  const release = useCallback(() => {
    cancelClose();
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null;
      setOpen(false);
    }, CLOSE_GRACE_MS);
  }, [cancelClose]);

  useEffect(() => cancelClose, [cancelClose]);

  if (items.length === 0) return null;

  return (
    <aside
      className={`toc-rail${open ? ' open' : ''}`}
      aria-label={t('toc.aria.label')}
      onMouseEnter={hold}
      onMouseLeave={release}
    >
      <nav className="toc-marker-list">
        {items.map((item) => {
          const depth = Math.min(item.level, 4);
          const active = activeSlug === item.slug;
          return (
            <a
              aria-current={active ? 'location' : undefined}
              className={`toc-marker level-${depth}${active ? ' active' : ''}`}
              href={`#${item.slug}`}
              key={item.id}
              onClick={(event) => {
                event.preventDefault();
                window.history.replaceState(null, '', `#${item.slug}`);
                scrollToAnchor(item.slug);
              }}
              title={item.label}
            >
              <span className="toc-marker-bar" />
            </a>
          );
        })}
      </nav>
      <div className="toc-popover">
        <nav className="toc-popover-list">
          {items.map((item) => {
            const active = activeSlug === item.slug;
            return (
              <a
                aria-current={active ? 'location' : undefined}
                className={`toc-popover-link${active ? ' active' : ''}`}
                href={`#${item.slug}`}
                key={`panel-${item.id}`}
                onClick={(event) => {
                  event.preventDefault();
                  window.history.replaceState(null, '', `#${item.slug}`);
                  scrollToAnchor(item.slug);
                }}
                style={{ paddingLeft: `${12 + Math.max(0, item.level - 1) * 14}px` }}
                title={item.label}
              >
                {renderSegments(item.segments, item.id)}
              </a>
            );
          })}
        </nav>
      </div>
    </aside>
  );
}
