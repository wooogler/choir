import type { TocItem } from '../types';
import { scrollToAnchor } from '../utils/docs';

type FloatingTocProps = {
  activeSlug: string;
  items: TocItem[];
};

export function FloatingToc({ activeSlug, items }: FloatingTocProps) {
  if (items.length === 0) return null;

  return (
    <aside className="toc-rail" aria-label="Table of contents">
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
              >
                {item.label}
              </a>
            );
          })}
        </nav>
      </div>
    </aside>
  );
}
