import type { PushHandler } from './types.js';

/**
 * Routes outbound messages to the correct adapter based on channel prefix.
 *
 * Adapters register a push handler keyed by their channel prefix (e.g., "tg-").
 * When send() is called, the registry finds the matching prefix and delegates.
 */
export class PushRegistry {
  private handlers = new Map<string, PushHandler>();

  register(prefix: string, handler: PushHandler): void {
    this.handlers.set(prefix, handler);
    console.log(`[push-registry] registered handler for prefix: ${prefix}`);
  }

  async send(channel: string, text: string): Promise<boolean> {
    for (const [prefix, handler] of this.handlers) {
      if (channel.startsWith(prefix)) {
        return handler(channel, text);
      }
    }
    return false;
  }

  get prefixes(): string[] {
    return [...this.handlers.keys()];
  }
}
