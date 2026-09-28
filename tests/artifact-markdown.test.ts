import { artifactFilename } from '../src/runtime/artifact-download.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { artifactDownloadLink, releaseArtifactDownloads, renderArtifactMarkdown } from '../src/ui/artifact-markdown.js';

let dom: JSDOM;
beforeEach(() => {
  dom = new JSDOM('');
  vi.stubGlobal('document', dom.window.document);
});
afterEach(() => { releaseArtifactDownloads(); dom.window.close(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('artifact Markdown display and downloads', () => {
  it('renders report headings, emphasis, nested lists, tables and literal code', () => {
    const view = renderArtifactMarkdown('# 天气报告\n\n**晴天**，注意 *防晒*。\n\n- 外套\n  - 薄款\n\n| 日期 | 温度 |\n| --- | ---: |\n| 十一 | 22℃ |\n\n```html\n<script>alert(1)</script>\n```');
    expect(view.querySelector('h1')?.textContent).toBe('天气报告');
    expect(view.querySelector('strong')?.textContent).toBe('晴天');
    expect(view.querySelector('ul ul li')?.textContent).toBe('薄款');
    expect(view.querySelector('.markdown-table-scroll[tabindex="0"] table td')?.textContent).toBe('十一');
    expect(view.querySelector('td[align="right"]')?.textContent).toBe('22℃');
    expect(view.querySelector('pre code')?.textContent).toContain('<script>alert(1)</script>');
    expect(view.querySelector('script')).toBeNull();
  });

  it('removes active HTML, event handlers, unsafe links and styles from model output', () => {
    const view = renderArtifactMarkdown('[来源](https://example.com/weather)\n\n[坏链接](javascript:alert%281%29)\n\n<a href="data:text/html,bad" onclick="alert(1)">data</a><iframe src="https://bad.test"></iframe><svg onload="alert(1)"></svg><img src=x onerror="alert(1)"><style>body{display:none}</style><form><input name=token></form><p id="run-title" style="position:fixed">正文</p>');
    expect(view.querySelector('script,iframe,svg,img,style,form,input,[onclick],[onerror],[onload],[style],[id]')).toBeNull();
    expect([...view.querySelectorAll('a[href]')].map(a => a.getAttribute('href'))).toEqual(['https://example.com/weather']);
    expect(view.querySelector('a[href]')?.rel).toBe('noopener noreferrer');
    expect(view.textContent).toContain('正文');
  });

  it('provides a direct file URL without credentials', () => {
    const link = artifactDownloadLink('run_123', { id: 'artifact/1', title: '北京/天气:报告' }, { getToken: () => null, onError: vi.fn() });
    expect(link.download).toBe('北京-天气-报告.md');
    expect(link.getAttribute('href')).toBe('/api/runs/run_123/artifacts/artifact%2F1/download');
  });

  it('uses bearer authentication without leaking the token in the download URL and reports failure', async () => {
    const request = vi.fn().mockResolvedValue(new Response('', { status: 403 }));
    vi.stubGlobal('fetch', request);
    const onError = vi.fn();
    const link = artifactDownloadLink('run_123', { id: 'artifact_1', title: '报告' }, { getToken: () => 'secret', onError });
    link.click();
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(expect.stringContaining('403')));
    expect(request).toHaveBeenCalledWith('/api/runs/run_123/artifacts/artifact_1/download', { headers: { authorization: 'Bearer secret' } });
    expect(link.href).not.toContain('secret');
    expect(link.textContent).toBe('下载 Markdown');
  });

  it('provides valid filenames for empty titles and long Unicode names', () => {
    expect(artifactFilename('...')).toBe('aeeis-artifact.md');
    expect(artifactFilename('报告.md')).toBe('报告.md');
    expect(new TextEncoder().encode(artifactFilename('🌦️'.repeat(100))).length).toBeLessThan(255);
  });
});
