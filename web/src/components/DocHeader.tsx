import type { ReactNode } from 'react';

type DocHeaderProps = {
  breadcrumb: string;
  onToggleSidebar: () => void;
  sidebarOpen: boolean;
  rightSlot: ReactNode;
  dirty?: boolean;
};

export function DocHeader({ breadcrumb, onToggleSidebar, sidebarOpen, rightSlot, dirty }: DocHeaderProps) {
  return (
    <header className={`doc-topbar${dirty ? ' dirty' : ''}`}>
      <div className="doc-topbar-left">
        <button
          type="button"
          className="doc-iconbutton"
          aria-label={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'}
          aria-pressed={sidebarOpen}
          onClick={onToggleSidebar}
        >
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
            <path
              fill="currentColor"
              d="M1.75 2.5a.75.75 0 0 0 0 1.5h12.5a.75.75 0 0 0 0-1.5H1.75Zm0 4.75a.75.75 0 0 0 0 1.5h12.5a.75.75 0 0 0 0-1.5H1.75Zm0 4.75a.75.75 0 0 0 0 1.5h12.5a.75.75 0 0 0 0-1.5H1.75Z"
            />
          </svg>
        </button>
        <span className="doc-topbar-breadcrumb" title={breadcrumb}>
          {breadcrumb}
        </span>
      </div>
      <div className="doc-topbar-right">{rightSlot}</div>
    </header>
  );
}
