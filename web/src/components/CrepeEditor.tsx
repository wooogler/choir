import { Crepe } from '@milkdown/crepe';
import { replaceAll } from '@milkdown/kit/utils';
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';

export interface CrepeEditorHandle {
  setReadonly: (value: boolean) => void;
  focus: () => void;
  getMarkdown: () => string;
  replaceMarkdown: (markdown: string) => void;
}

type CrepeEditorProps = {
  markdown: string;
  editable: boolean;
  onMarkdownChange?: (markdown: string) => void;
};

export const CrepeEditor = forwardRef<CrepeEditorHandle, CrepeEditorProps>(function CrepeEditor(
  { markdown, editable, onMarkdownChange },
  handleRef,
) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const crepeRef = useRef<Crepe | null>(null);
  const editableRef = useRef(editable);
  const onChangeRef = useRef(onMarkdownChange);
  onChangeRef.current = onMarkdownChange;
  editableRef.current = editable;

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
