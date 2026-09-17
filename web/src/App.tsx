import '@milkdown/crepe/theme/common/style.css';
import '@milkdown/crepe/theme/frame.css';
import './styles.css';
import { useEffect, useState } from 'react';
import { Dashboard } from './components/Dashboard';
import { DocViewer } from './components/DocViewer';
import { fillNodes, useT } from './i18n';
import { type Route, parseRoute } from './utils/docs';

export default function App() {
  const t = useT();
  const [route, setRoute] = useState<Route | null>(() => parseRoute());

  useEffect(() => {
    const onNavigate = () => setRoute(parseRoute());
    window.addEventListener('popstate', onNavigate);
    return () => window.removeEventListener('popstate', onNavigate);
  }, []);

  if (!route) {
    return (
      <div className="invalid-url">
        {fillNodes(t('app.invalidUrl'), { path: <code>/docs/:workspaceId/:filePath</code> })}
      </div>
    );
  }

  if (route.view === 'dashboard') {
    return <Dashboard workspaceId={route.workspaceId} fromFilePath={route.from} />;
  }

  return <DocViewer workspaceId={route.workspaceId} initialFilePath={route.filePath} />;
}
