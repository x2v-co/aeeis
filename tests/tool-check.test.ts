import { describe, expect, it } from 'vitest';
import { checkCombinedTools } from '../src/tool-check.js';
import { SandboxUnreachable, SandboxError } from '../src/docker-sandbox.js';
import type { ToolDescriptor, ToolGateway } from '../src/integrations.js';

const tool = (id: string, version = '1'): ToolDescriptor => ({ id, version, description: id, capabilities: ['read'], inputSchema: { type: 'object' }, outputSchema: { type: 'object' } });
const gateway = (list: () => Promise<ToolDescriptor[]>): ToolGateway => ({ listTools: list, invoke: async () => { throw new Error('not used'); } });
const local = (ids: string[], list: () => Promise<ToolDescriptor[]>) => ({ ...gateway(list), toolRefs: () => ids.map(id => ({ id, version: '3' })) });
const paused = () => Promise.reject(new SandboxUnreachable('instabox-agent-browser-test', 'ssh: connect to host port 22: Connection timed out'));
const remote = gateway(async () => [tool('web-search', '1'), tool('web-search', '2')]);

describe('deploy check of combined tools', () => {
  it('lists local and remote tools when the sandbox host answers', async () => {
    const lines: string[] = [];
    await expect(checkCombinedTools(local(['shell'], async () => [tool('shell', '3')]), remote, line => lines.push(line))).resolves.toBe(3);
    expect(lines).toEqual(['tools: 3 (local and remote)']);
  });

  it('passes with a warning when the sandbox host is paused', async () => {
    const lines: string[] = [];
    await expect(checkCombinedTools(local(['shell', 'browser'], paused), remote, line => lines.push(line))).resolves.toBe(4);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^tools: 4 \(local and remote; local tools from configuration, sandbox host NOT REACHABLE \(warning only\)/);
    expect(lines[0]).toContain('instabox-agent-browser-test');
  });

  it('still rejects a tool ID on both sides while the sandbox host is paused', async () => {
    await expect(checkCombinedTools(local(['shell', 'web-search'], paused), remote, () => undefined))
      .rejects.toThrow('Duplicate tool ID across local and remote gateways: web-search');
  });

  it('fails on any other sandbox or remote error', async () => {
    await expect(checkCombinedTools(local(['shell'], () => Promise.reject(new SandboxError('Sandbox image unavailable; run npm run sandbox:build'))), remote, () => undefined))
      .rejects.toThrow('Sandbox image unavailable');
    await expect(checkCombinedTools(local(['shell'], paused), gateway(() => Promise.reject(new Error('Toolkit manifest signature is not trusted'))), () => undefined))
      .rejects.toThrow('signature');
  });
});
