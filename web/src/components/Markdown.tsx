import { memo, useMemo } from 'react';
import clsx from 'clsx';
import { renderMarkdown } from '../lib/markdown';

// Sanitized markdown. Only renders again when the text changes.
export const Markdown = memo(function Markdown({ text, className }: { text: string; className?: string }) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  return <div className={clsx('markdown', className)} dangerouslySetInnerHTML={{ __html: html }} />;
});
