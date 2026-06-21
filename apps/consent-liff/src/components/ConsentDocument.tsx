import { parseMarkdown } from '../lib/markdown.js';

interface ConsentDocumentProps {
  bodyMd: string;
}

/**
 * consent_documents.body_md を軽量 markdown で render する。
 * a11y: 本文は text-base (16px) 以上・行間 leading-relaxed で可読性を確保。
 */
export default function ConsentDocument({ bodyMd }: ConsentDocumentProps) {
  const blocks = parseMarkdown(bodyMd);
  return (
    <div className="space-y-3 text-base leading-relaxed text-neutral-800">
      {blocks.map((block, i) => {
        if (block.type === 'heading') {
          if (block.level === 1) {
            return (
              <h2 key={i} className="text-xl font-bold text-neutral-900">
                {block.text}
              </h2>
            );
          }
          if (block.level === 2) {
            return (
              <h3 key={i} className="text-lg font-bold text-neutral-900">
                {block.text}
              </h3>
            );
          }
          return (
            <h4 key={i} className="text-base font-semibold text-neutral-900">
              {block.text}
            </h4>
          );
        }
        if (block.type === 'list') {
          return (
            <ul key={i} className="list-disc space-y-1 pl-5">
              {block.items.map((item, j) => (
                <li key={j}>{item}</li>
              ))}
            </ul>
          );
        }
        return <p key={i}>{block.text}</p>;
      })}
    </div>
  );
}
