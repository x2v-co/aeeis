import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { buildApp } from '../src/runtime/http.js';
import { FileRunRepository } from '../src/runtime/repository.js';

describe('multi-bot channel sample', () => {
  it('serves the sample beside the workbench without an API token', async () => {
    const repository = new FileRunRepository(await mkdtemp(join(tmpdir(), 'aeeis-team-')));
    await repository.init();
    const app = buildApp({ repository });
    try {
      const workbench = await app.inject({ method: 'GET', url: '/' });
      expect(workbench.statusCode).toBe(200);
      expect(workbench.body).toContain('href="/team/"');
      expect(workbench.body).toContain('多 Bot 频道');
      const page = await app.inject({ method: 'GET', url: '/team/' });
      expect(page.statusCode).toBe(200);
      expect(page.headers['content-type']).toContain('text/html');
      expect(page.body).toContain('多 Bot 工作室');
      expect(page.body).toContain('href="/"');
      expect(page.body).toContain('当前工作台');
      const script = await app.inject({ method: 'GET', url: '/team/app.js' });
      const style = await app.inject({ method: 'GET', url: '/team/styles.css' });
      expect(script.statusCode).toBe(200);
      expect(style.statusCode).toBe(200);
      expect(script.body).toContain('function sendMessage');
    } finally {
      await app.close();
    }
  });

  it('approves, answers, hands a new request to 小安, and opens the board and studio', async () => {
    const [html, source] = await Promise.all([
      readFile('public/team/index.html', 'utf8'),
      readFile('public/team/app.js', 'utf8'),
    ]);
    const dom = new JSDOM(html, { url: 'http://localhost/team/', runScripts: 'outside-only', pretendToBeVisual: true });
    dom.window.innerWidth = 1280;
    dom.window.eval(source);
    const doc = dom.window.document;
    const text = () => doc.body.textContent ?? '';
    expect(doc.querySelector('.shell-switch')?.getAttribute('href')).toBe('/');
    expect(text()).toContain('小安');

    doc.querySelector<HTMLButtonElement>('[data-action="approve"][data-decision="always"]')!.click();
    expect(text()).toContain('批准，注意只看公开页面。');
    expect(text()).toContain('已批准读取 3 个外部页面');

    const wednesday = [...doc.querySelectorAll<HTMLButtonElement>('[data-action="answer"]')].find(button => button.textContent === '周三');
    expect(wednesday).toBeDefined();
    wednesday!.click();
    expect(text()).toContain('按周三评估。');
    expect(text()).toContain('按周三重排风险');

    const input = doc.querySelector<HTMLTextAreaElement>('#composerInput')!;
    input.value = '再给我一版发布风险摘要';
    doc.querySelector<HTMLFormElement>('#composerForm')!.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    expect(text()).toContain('再给我一版发布风险摘要');
    await new Promise(resolve => setTimeout(resolve, 1100));
    expect(text()).toContain('我让阿研核对变更记录');
    expect(text()).toContain('小安已拆解并创建任务');

    doc.querySelector<HTMLButtonElement>('[data-action="open-board"]')!.click();
    expect(doc.querySelector<HTMLElement>('#boardOverlay')!.hidden).toBe(false);
    expect(text()).toContain('任务看板');

    doc.querySelector<HTMLButtonElement>('[data-action="toggle-studio"]')!.click();
    expect(doc.querySelector<HTMLElement>('#studio')!.hidden).toBe(false);
    expect(text()).toContain('已打开工作室视图');
    expect(doc.querySelector<HTMLElement>('#content')!.hidden).toBe(true);

    dom.window.close();
  });
});
