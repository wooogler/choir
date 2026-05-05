import '@blocknote/mantine/style.css';
import '@mantine/core/styles.css';
import { MantineProvider } from '@mantine/core';
import './styles.css';
import { DocViewer } from './components/DocViewer';
import { parseDocsUrl } from './utils/docs';

export default function App() {
  const parsed = parseDocsUrl();

  if (!parsed) {
    return (
      <MantineProvider>
        <div className="invalid-url">
          Invalid URL. Expected <code>/docs/:workspaceId/:filePath</code>
        </div>
      </MantineProvider>
    );
  }

  return (
    <MantineProvider>
      <DocViewer workspaceId={parsed.workspaceId} initialFilePath={parsed.filePath} />
    </MantineProvider>
  );
}
