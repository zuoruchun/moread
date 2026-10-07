import { parseMarkdown, type ParseOptions } from './parser.ts';
import { escapeHtml } from './highlight.ts';
import markdownCSS from '../styles/markdown.css?raw';
import highlightCSS from '../styles/highlight-theme.css?raw';
import printCSS from '../styles/pdf.css?raw';

export interface PDFSnapshot {
  html: string;
  title: string;
  filePath: string | null;
}

// A self-contained, script-free document; never print the application's live DOM.
export function createPDFSnapshot(markdown: string, title: string, options: ParseOptions): PDFSnapshot {
  let body = parseMarkdown(markdown, { ...options, readonly: true });
  body = body.replace(/<button\b[^>]*>[\s\S]*?<\/button>/gi, '')
    .replace(/\sloading="lazy"/g, ' loading="eager"');
  const imageSources = options.allowRemoteImages ? 'data: mored: https: http:' : 'data: mored:';
  const policy = `default-src 'none'; style-src 'unsafe-inline'; img-src ${imageSources}; font-src data:; base-uri 'none'`;
  return {
    title,
    filePath: options.currentFilePath ?? null,
    html: `<!doctype html><html lang="zh-CN" data-theme="light"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${policy}"><title>${escapeHtml(title)}</title>
<style>${markdownCSS}\n${highlightCSS}\n${printCSS}</style></head>
<body><article class="markdown-body">${body}</article></body></html>`
  };
}
