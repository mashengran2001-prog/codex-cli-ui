import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { Copy, ExternalLink, FileText, X } from "lucide-react";
import { useUiCopy } from "../i18n";
import type { DocumentFile } from "../types";

export default function DocumentViewer({ document, onClose }: { document: DocumentFile; onClose(): void }) {
  const copy = useUiCopy().document;
  return (
    <article className="document-viewer">
      <header>
        <span><FileText size={15} /><strong>{document.name}</strong><small>{Math.max(1, Math.round(document.size / 1024))} KB</small></span>
        <div>
          <button title={copy.copyPath} onClick={() => void window.codex.copyText(document.path)}><Copy size={14} /></button>
          <button title={copy.reveal} onClick={() => void window.codex.revealPath(document.path)}><ExternalLink size={14} /></button>
          <button title={copy.close} onClick={onClose}><X size={14} /></button>
        </div>
      </header>
      <div className={`document-content ${document.kind}`}>
        {document.kind === "markdown" ? (
          <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]}>{document.content}</ReactMarkdown>
        ) : (
          <pre className="code-viewer"><code>{document.content.split("\n").map((line, index) => (
            <span className="code-line" key={index}><i className="line-no" aria-hidden="true">{index + 1}</i>{line || "\u00A0"}</span>
          ))}</code></pre>
        )}
      </div>
    </article>
  );
}
