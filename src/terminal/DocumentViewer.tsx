import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { Copy, ExternalLink, FileText, ImageOff, X } from "lucide-react";
import { useUiCopy } from "../i18n";
import type { DocumentFile } from "../types";

function resolveImagePath(basePath: string, source: string) {
  const lower = source.toLowerCase();
  if (/^[a-z]:[\\/]/i.test(source) || source.startsWith("\\\\")) return source;
  const base = basePath.replace(/[\\/]+$/, "");
  const index = Math.max(base.lastIndexOf("\\"), base.lastIndexOf("/"));
  const directory = index > 2 ? base.slice(0, index) : base;
  const relative = source.replaceAll("/", "\\");
  const parts = relative.split("\\").filter(Boolean);
  const stack: string[] = [];
  for (const part of parts) {
    if (part === ".") continue;
    if (part === "..") stack.pop();
    else stack.push(part);
  }
  return stack.length ? `${directory}\\${stack.join("\\")}` : directory;
}

function MarkdownImage({ src, alt, title, basePath, root, onError }: {
  src: string;
  alt?: string;
  title?: string;
  basePath: string;
  root: string;
  onError(message: string): void;
}) {
  const [dataUri, setDataUri] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const lower = src.toLowerCase();
  const isRemote = lower.startsWith("https://") || lower.startsWith("http://");
  const isEmbedded = lower.startsWith("data:") || lower.startsWith("blob:") || lower.startsWith("file:");
  useEffect(() => {
    if (isRemote || isEmbedded) return;
    let cancelled = false;
    void window.codex.readDocumentImage(root, resolveImagePath(basePath, src)).then((uri) => {
      if (cancelled) return;
      if (uri) setDataUri(uri);
      else setFailed(true);
    }).catch((reason: unknown) => {
      if (cancelled) return;
      setFailed(true);
      onError(reason instanceof Error ? reason.message : "");
    });
    return () => { cancelled = true; };
  }, [basePath, isEmbedded, isRemote, onError, root, src]);
  const finalSrc = isRemote || isEmbedded ? src : dataUri;
  if (failed) {
    return <span className="markdown-image-fallback" title={src}><ImageOff size={14} />{alt || src}</span>;
  }
  if (!finalSrc) return <span className="markdown-image-loading">{alt || src}</span>;
  return <img src={finalSrc} alt={alt || ""} title={title} />;
}

export default function DocumentViewer({ document, root, onClose, onError }: {
  document: DocumentFile;
  root: string;
  onClose(): void;
  onError(message: string): void;
}) {
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
          <ReactMarkdown
            remarkPlugins={[remarkGfm, remarkMath]}
            rehypePlugins={[rehypeKatex]}
            components={{
              img: (props) => <MarkdownImage
                src={String(props.src ?? "")}
                alt={props.alt}
                title={props.title}
                basePath={document.path}
                root={root}
                onError={onError}
              />,
            }}
          >{document.content}</ReactMarkdown>
        ) : (
          <pre className="code-viewer"><code>{document.content.split("\n").map((line, index) => (
            <span className="code-line" key={index}><i className="line-no" aria-hidden="true">{index + 1}</i>{line || "\u00A0"}</span>
          ))}</code></pre>
        )}
      </div>
    </article>
  );
}
