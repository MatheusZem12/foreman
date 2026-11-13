import { useRef, useState, type ClipboardEvent, type DragEvent, type RefObject } from 'react';
import { ImagePlus, Loader2 } from 'lucide-react';
import { useToast } from './ui';
import { api } from '../lib/api';
import { t } from '../lib/i18n';

const ACCEPT = 'image/png,image/jpeg,image/gif,image/webp';
const images = (files: FileList | null | undefined) => Array.from(files ?? []).filter((f) => f.type.startsWith('image/'));

// Images in a text that goes to the agent: paste (Ctrl+V), drag and drop or the button.
// Each one is uploaded and becomes ![name](/api/uploads/…) where the cursor was; the
// server hands the file to the agent along with the request.
export function useImageAttach(ref: RefObject<HTMLTextAreaElement>, update: (fn: (prev: string) => string) => void) {
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState(0);

  const add = async (files: File[]) => {
    if (!files.length) return;
    const at = ref.current?.selectionEnd;
    setPending((n) => n + files.length);
    const links: string[] = [];
    for (const f of files) {
      try {
        const { url } = await api.upload(f);
        const alt = f.name.replace(/\.[^.]+$/, '').replace(/[[\]]/g, '') || 'image';
        links.push(`![${alt}](${url})`);
      } catch (err) {
        toast('error', t('Couldn\'t attach {0}: {1}', f.name, (err as Error).message));
      } finally {
        setPending((n) => n - 1);
      }
    }
    if (!links.length) return;
    update((prev) => {
      const pos = Math.min(at ?? prev.length, prev.length);
      const before = prev.slice(0, pos);
      const after = prev.slice(pos);
      return `${before}${before && !before.endsWith('\n') ? '\n' : ''}${links.join('\n')}${after.startsWith('\n') ? '' : '\n'}${after}`;
    });
  };

  const textareaProps = {
    onPaste: (e: ClipboardEvent<HTMLTextAreaElement>) => {
      const files = images(e.clipboardData.files);
      if (files.length) {
        e.preventDefault();
        add(files);
      }
    },
    onDragOver: (e: DragEvent<HTMLTextAreaElement>) => {
      if (Array.from(e.dataTransfer.types).includes('Files')) e.preventDefault();
    },
    onDrop: (e: DragEvent<HTMLTextAreaElement>) => {
      const files = images(e.dataTransfer.files);
      if (files.length) {
        e.preventDefault();
        add(files);
      }
    }
  };

  const button = (
    <>
      <input ref={input} type="file" accept={ACCEPT} multiple hidden onChange={(e) => { add(images(e.target.files)); e.target.value = ''; }} />
      <button type="button" onClick={() => input.current?.click()} disabled={pending > 0} title={t('Attach image (or paste/drop it in the text)')} aria-label={t('Attach image')}
        className="icon-btn size-7">
        {pending > 0 ? <Loader2 className="size-3.5 animate-spin" /> : <ImagePlus className="size-3.5" />}
      </button>
    </>
  );

  return { textareaProps, button, uploading: pending > 0 };
}
