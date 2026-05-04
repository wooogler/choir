import '@blocknote/mantine/style.css';
import '@mantine/core/styles.css';
import { useEffect, useState } from 'react';
import { BlockNoteView } from '@blocknote/mantine';
import { useCreateBlockNote } from '@blocknote/react';
import { MantineProvider } from '@mantine/core';

function parseDocsUrl(): { workspaceId: string; filePath: string } | null {
  // URL pattern: /docs/:workspaceId/:filePath*
  const match = window.location.pathname.match(/^\/docs\/([^/]+)\/(.+)$/);
  if (!match) return null;
  return { workspaceId: match[1], filePath: match[2] };
}

function scrollToAnchor(hash: string): void {
  if (!hash) return;
  const target = hash.startsWith('#') ? hash.slice(1) : hash;

  const headings = document.querySelectorAll('h1, h2, h3, h4, h5, h6');
  for (const el of headings) {
    const anchor = (el.textContent ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
    if (anchor === target) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      break;
    }
  }
}

function DocViewer({ workspaceId, filePath }: { workspaceId: string; filePath: string }) {
  const editor = useCreateBlockNote();
  const [title, setTitle] = useState('');
  const [error, setError] = useState('');
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setReady(false);
    setError('');

    fetch(`/api/docs/${workspaceId}/${filePath}`)
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
        return r.json() as Promise<{ content: string; filePath: string }>;
      })
      .then(async ({ content, filePath: fp }) => {
        setTitle(fp.split('/').pop()?.replace(/\.md$/i, '') ?? fp);
        const blocks = await editor.tryParseMarkdownToBlocks(content);
        editor.replaceBlocks(editor.document, blocks);
        setReady(true);
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : 'Failed to load document');
      });
  }, [workspaceId, filePath, editor]);

  useEffect(() => {
    if (!ready) return;
    // Give BlockNote a tick to flush DOM before scrolling
    const id = setTimeout(() => scrollToAnchor(window.location.hash), 100);
    return () => clearTimeout(id);
  }, [ready]);

  if (error) {
    return (
      <div style={{ padding: '2rem', color: '#c00' }}>
        <strong>Error:</strong> {error}
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 860, margin: '0 auto', padding: '2rem 1rem' }}>
      {title && (
        <p style={{ fontSize: 13, color: '#888', marginBottom: '1.5rem', fontFamily: 'monospace' }}>
          {filePath}
        </p>
      )}
      <BlockNoteView editor={editor} editable={false} />
    </div>
  );
}

export default function App() {
  const parsed = parseDocsUrl();

  if (!parsed) {
    return (
      <MantineProvider>
        <div style={{ padding: '2rem', color: '#666' }}>
          Invalid URL. Expected <code>/docs/:workspaceId/:filePath</code>
        </div>
      </MantineProvider>
    );
  }

  return (
    <MantineProvider>
      <DocViewer workspaceId={parsed.workspaceId} filePath={parsed.filePath} />
    </MantineProvider>
  );
}
