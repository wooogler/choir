import '@milkdown/crepe/theme/common/style.css';
import '@milkdown/crepe/theme/frame.css';
import './styles.css';
import { DocViewer } from './components/DocViewer';
import { parseDocsUrl } from './utils/docs';

export default function App() {
  const parsed = parseDocsUrl();

  if (!parsed) {
    return (
      <div className="invalid-url">
        Invalid URL. Expected <code>/docs/:workspaceId/:filePath</code>
      </div>
    );
  }

  return <DocViewer workspaceId={parsed.workspaceId} initialFilePath={parsed.filePath} />;
}
