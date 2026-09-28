import { artifactFilename } from '../runtime/artifact-download.js';
import { marked } from 'marked';
import createDOMPurify, { type WindowLike } from 'dompurify';

/** Model output is untrusted. Only passive document markup reaches the page. */
export function renderArtifactMarkdown(content: string, doc: Document = document): HTMLElement {
  const root = doc.createElement('div');
  root.className = 'artifact-markdown';
  const purifier = createDOMPurify(doc.defaultView as unknown as WindowLike);
  const fragment = purifier.sanitize(marked.parse(content, { async: false, gfm: true, breaks: true }), {
    ALLOWED_TAGS: ['p', 'br', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'em', 'del', 'blockquote', 'ul', 'ol', 'li', 'hr', 'pre', 'code', 'a', 'table', 'thead', 'tbody', 'tr', 'th', 'td'],
    ALLOWED_ATTR: ['href', 'title', 'start', 'align'],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    RETURN_DOM_FRAGMENT: true,
  });
  root.append(fragment);
  for (const link of root.querySelectorAll('a')) {
    const href = link.getAttribute('href') ?? '';
    if (!/^(https?:\/\/|mailto:)/i.test(href)) link.removeAttribute('href');
    else { link.target = '_blank'; link.rel = 'noopener noreferrer'; }
  }
  for (const table of root.querySelectorAll('table')) {
    const scroll = doc.createElement('div');
    scroll.className = 'markdown-table-scroll';
    scroll.tabIndex = 0;
    scroll.setAttribute('role', 'region');
    scroll.setAttribute('aria-label', '报告表格，可横向滚动');
    table.before(scroll);
    scroll.append(table);
  }
  return root;
}

const downloadUrls = new Set<string>();
export function artifactDownloadLink(runId: string, artifact: { id: string; title: string }, options: { getToken: () => string | null; onError: (text: string) => void }): HTMLAnchorElement {
  const link = document.createElement('a');
  link.className = 'artifact-download';
  link.textContent = '下载 Markdown';
  link.download = artifactFilename(artifact.title);
  link.setAttribute('aria-label', `下载 Markdown：${artifact.title}`);
  link.href = `/api/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifact.id)}/download`;
  let busy = false;
  link.addEventListener('click', async event => {
    const token = options.getToken();
    if (!token) return;
    event.preventDefault();
    if (busy) return;
    busy = true;
    link.textContent = '正在下载…';
    try {
      const response = await fetch(link.href, { headers: { authorization: `Bearer ${token}` } });
      if (!response.ok) throw new Error(`下载失败（HTTP ${response.status}），请检查连接和访问权限。`);
      const url = URL.createObjectURL(await response.blob());
      downloadUrls.add(url);
      const save = document.createElement('a');
      save.href = url;
      save.download = link.download;
      document.body.append(save);
      save.click();
      save.remove();
      // Keep the URL alive across polling renders while the browser starts saving.
      setTimeout(() => { URL.revokeObjectURL(url); downloadUrls.delete(url); }, 60_000);
    } catch (error) {
      options.onError(error instanceof Error ? error.message : '下载失败，请稍后重试。');
    } finally {
      busy = false;
      link.textContent = '下载 Markdown';
    }
  });
  return link;
}

export function releaseArtifactDownloads(): void {
  for (const url of downloadUrls) URL.revokeObjectURL(url);
  downloadUrls.clear();
}
