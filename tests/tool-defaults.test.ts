import { describe, expect, it, vi } from 'vitest';
import { resolveToolDefaults } from '../src/tool-defaults.js';
import type { ToolGateway } from '../src/integrations.js';

const local = [{ id: 'shell', version: '3' }, { id: 'read', version: '3' }];
const gateway = (listTools: ToolGateway['listTools']): ToolGateway => ({ listTools, invoke: async () => { throw new Error('unused'); } });

describe('default tools at startup', () => {
  it('starts when the remote Toolkit is down, keeping its defaults unchecked and still checking local ones', async () => {
    const warn = vi.fn();
    const down = gateway(async () => { throw new Error('HTTP 530'); });
    expect(await resolveToolDefaults('shell,web-search@2', [], down, local, warn)).toEqual(['shell', 'web-search@2']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('HTTP 530'));
    await expect(resolveToolDefaults('shell@9,web-search@2', [], down, local, warn)).rejects.toThrow(/shell@9 must match/);
  });
  it('checks remote defaults when the Toolkit answers', async () => {
    const up = gateway(async () => [{ id: 'web-search', version: '2', capabilities: ['network'], inputSchema: {}, outputSchema: {} }]);
    expect(await resolveToolDefaults('shell,web-search@2', [], up, local)).toEqual(['shell', 'web-search@2']);
    await expect(resolveToolDefaults('web-search@9', [], up, local)).rejects.toThrow(/must match/);
  });
});
