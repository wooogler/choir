import { Crepe } from '@milkdown/crepe';
import { replaceAll } from '@milkdown/kit/utils';
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { resolveAssetDisplayUrl, toDocRelativeAssetPath, uploadAsset } from '../utils/assets';

export interface CrepeEditorHandle {
  setReadonly: (value: boolean) => void;
  focus: () => void;
  getMarkdown: () => string;
  replaceMarkdown: (markdown: string) => void;
}

type CrepeEditorProps = {
  markdown: string;
  editable: boolean;
  workspaceId: string;
  filePath: string;
  onMarkdownChange?: (markdown: string) => void;
};

export const CrepeEditor = forwardRef<CrepeEditorHandle, CrepeEditorProps>(function CrepeEditor(
  { markdown, editable, workspaceId, filePath, onMarkdownChange },
  handleRef,
) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const crepeRef = useRef<Crepe | null>(null);
  const editableRef = useRef(editable);
  const onChangeRef = useRef(onMarkdownChange);
  // Kept in refs so the upload/display callbacks always read the current
  // document context without forcing the editor to remount.
  const workspaceIdRef = useRef(workspaceId);
  const filePathRef = useRef(filePath);
  onChangeRef.current = onMarkdownChange;
  editableRef.current = editable;
  workspaceIdRef.current = workspaceId;
  filePathRef.current = filePath;

  useImperativeHandle(
    handleRef,
    () => ({
      setReadonly(value) {
        crepeRef.current?.setReadonly(value);
      },
      focus() {
        containerRef.current?.querySelector<HTMLElement>('.ProseMirror')?.focus({ preventScroll: true });
      },
      getMarkdown() {
        return crepeRef.current?.getMarkdown() ?? '';
      },
      replaceMarkdown(markdown) {
        crepeRef.current?.editor.action(replaceAll(markdown));
      },
    }),
    [],
  );

  useEffect(() => {
    if (!containerRef.current) return;

    let cancelled = false;
    const crepe = new Crepe({
      root: containerRef.current,
      defaultValue: markdown,
      featureConfigs: {
        [Crepe.Feature.ImageBlock]: {
          onUpload: async (file: File) => {
            const repoRelative = await uploadAsset(workspaceIdRef.current, file);
            return toDocRelativeAssetPath(filePathRef.current, repoRelative);
          },
          proxyDomURL: (url: string) => resolveAssetDisplayUrl(workspaceIdRef.current, filePathRef.current, url),
        },
      },
    });

    crepe.on((api) => {
      api.markdownUpdated((_ctx, nextMarkdown) => {
        try {
          onChangeRef.current?.(nextMarkdown);
        } catch (error) {
          console.error('markdownUpdated handler failed', error);
        }
      });
    });

    crepe
      .create()
      .then(() => {
        if (cancelled) return;
        crepeRef.current = crepe;
        crepe.setReadonly(!editableRef.current);
      })
      .catch((error) => {
        console.error('Failed to initialize Crepe editor', error);
      });

    return () => {
      cancelled = true;
      crepeRef.current = null;
      crepe.destroy().catch(() => {
        // ignore destroy errors during unmount
      });
    };
  }, [markdown]);

  useEffect(() => {
    crepeRef.current?.setReadonly(!editable);
  }, [editable]);

  return <div ref={containerRef} className="crepe-host" />;
});
