import { describe, it, expect, vi } from 'vitest';
import { PushRegistry } from './push-registry.js';

describe('PushRegistry', () => {
  it('routes to the correct handler by prefix', async () => {
    const registry = new PushRegistry();
    const tgHandler = vi.fn().mockResolvedValue(true);
    const slackHandler = vi.fn().mockResolvedValue(true);
    registry.register('tg-', tgHandler);
    registry.register('slack-', slackHandler);

    await registry.send('tg-12345', 'hello');
    expect(tgHandler).toHaveBeenCalledWith('tg-12345', 'hello', undefined);
    expect(slackHandler).not.toHaveBeenCalled();
  });

  it('returns false when no handler matches', async () => {
    const registry = new PushRegistry();
    registry.register('tg-', vi.fn().mockResolvedValue(true));

    const result = await registry.send('unknown-channel', 'hello');
    expect(result).toBe(false);
  });

  it('lists registered prefixes', () => {
    const registry = new PushRegistry();
    registry.register('tg-', vi.fn());
    registry.register('slack-', vi.fn());

    expect(registry.prefixes).toEqual(['tg-', 'slack-']);
  });

  it('propagates handler return value', async () => {
    const registry = new PushRegistry();
    registry.register('tg-', vi.fn().mockResolvedValue(false));

    const result = await registry.send('tg-123', 'hello');
    expect(result).toBe(false);
  });

  it('forwards media to handler', async () => {
    const registry = new PushRegistry();
    const handler = vi.fn().mockResolvedValue(true);
    registry.register('tg-', handler);

    const media = { filePath: '/tmp/chart.png' };
    await registry.send('tg-123', 'caption', media);
    expect(handler).toHaveBeenCalledWith('tg-123', 'caption', media);
  });

  it('works without media (backward compat)', async () => {
    const registry = new PushRegistry();
    const handler = vi.fn().mockResolvedValue(true);
    registry.register('tg-', handler);

    await registry.send('tg-123', 'hello');
    expect(handler).toHaveBeenCalledWith('tg-123', 'hello', undefined);
  });
});
