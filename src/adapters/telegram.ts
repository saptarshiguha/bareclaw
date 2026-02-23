/**
 * Telegram adapter — reference implementation for BAREclaw adapters.
 *
 * Channel key: `tg-<chatId>` — one channel per Telegram chat.
 *
 * This adapter demonstrates the full pattern:
 * - Derive a channel key from the protocol's session boundary (chat ID)
 * - Call processManager.send() with an onEvent callback for streaming
 * - Chain intermediate sends (sendChain) to preserve message ordering
 * - Let ProcessManager handle all queuing for concurrent messages
 */
import { Telegraf } from 'telegraf';
import type { Context } from 'telegraf';
import type { Config } from '../config.js';
import type { ProcessManager } from '../core/process-manager.js';
import type { ClaudeEvent, PushHandler } from '../core/types.js';

const MAX_MESSAGE_LENGTH = 4096;

/** Escape special HTML characters */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Split text into chunks that fit Telegram's message limit */
function splitText(text: string): string[] {
  if (text.length <= MAX_MESSAGE_LENGTH) return [text];
  const parts: string[] = [];
  for (let i = 0; i < text.length; i += MAX_MESSAGE_LENGTH) {
    parts.push(text.substring(i, i + MAX_MESSAGE_LENGTH));
  }
  return parts;
}

/** Send a message as HTML, falling back to plain text */
async function sendHtml(ctx: Context, html: string): Promise<void> {
  for (const chunk of splitText(html)) {
    await ctx.reply(chunk, { parse_mode: 'HTML' }).catch(() =>
      ctx.reply(chunk.replace(/<[^>]*>/g, ''))
    );
  }
}

// Internal tools that don't need Telegram notifications
const HIDDEN_TOOLS = new Set(['EnterPlanMode', 'ExitPlanMode', 'Task', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet']);

/** Format an Edit tool call as a collapsible diff */
function formatDiff(input: Record<string, unknown>): string {
  const file = escapeHtml(String(input.file_path || 'unknown'));
  const old = escapeHtml(String(input.old_string || ''));
  const new_ = escapeHtml(String(input.new_string || ''));

  const diffLines: string[] = [];
  for (const line of old.split('\n')) {
    diffLines.push('- ' + line);
  }
  for (const line of new_.split('\n')) {
    diffLines.push('+ ' + line);
  }

  return `<code>Edit: ${file}</code>\n<blockquote expandable><pre>${diffLines.join('\n')}</pre></blockquote>`;
}

/** Format a Write tool call as a collapsible preview */
function formatWrite(input: Record<string, unknown>): string {
  const file = escapeHtml(String(input.file_path || 'unknown'));
  const content = escapeHtml(String(input.content || ''));
  const preview = content.length > 1000 ? content.substring(0, 1000) + '...' : content;
  return `<code>Write: ${file}</code>\n<blockquote expandable><pre>${preview}</pre></blockquote>`;
}

/** Format an AskUserQuestion tool call */
function formatQuestion(input: Record<string, unknown>): string {
  const questions = input.questions as Array<Record<string, unknown>> | undefined;
  if (!questions?.length) return '<code>AskUserQuestion</code>';

  const parts: string[] = [];
  for (const q of questions) {
    parts.push(`<b>${escapeHtml(String(q.question || ''))}</b>`);
    const options = q.options as Array<Record<string, unknown>> | undefined;
    if (options?.length) {
      for (let i = 0; i < options.length; i++) {
        const opt = options[i];
        const label = escapeHtml(String(opt.label || ''));
        const desc = opt.description ? ` — ${escapeHtml(String(opt.description))}` : '';
        parts.push(`  ${i + 1}. ${label}${desc}`);
      }
    }
  }
  return parts.join('\n');
}

/** Extract displayable content from a stream event */
function extractContent(event: ClaudeEvent): { text?: string; toolUse?: string; toolResult?: string } {
  if (!event.message?.content) return {};

  // Handle assistant events (text + tool calls) and user events (tool results)
  if (event.type !== 'assistant' && event.type !== 'user') return {};

  const texts: string[] = [];
  const tools: string[] = [];
  const results: string[] = [];

  for (const block of event.message.content) {
    if (block.type === 'text' && block.text?.trim()) {
      texts.push(block.text);
    } else if (block.type === 'tool_use' && block.name && !HIDDEN_TOOLS.has(block.name)) {
      const input = block.input as Record<string, unknown> | undefined;
      if (block.name === 'Edit' && input) {
        tools.push(formatDiff(input));
      } else if (block.name === 'Write' && input) {
        tools.push(formatWrite(input));
      } else if (block.name === 'AskUserQuestion' && input) {
        tools.push(formatQuestion(input));
      } else {
        const target = input?.file_path || input?.path || input?.pattern || input?.command;
        const label = escapeHtml(target ? `${block.name}: ${target}` : block.name);
        tools.push(`<code>${label}</code>`);
      }
    } else if (block.type === 'tool_result') {
      // Tool output (e.g. bash stdout). Content can be a string or array of blocks.
      const content = block.content as string | Array<Record<string, unknown>> | undefined;
      if (typeof content === 'string' && content.trim()) {
        results.push(content);
      } else if (Array.isArray(content)) {
        for (const sub of content) {
          if (sub.type === 'text' && typeof sub.text === 'string' && (sub.text as string).trim()) {
            results.push(sub.text as string);
          }
        }
      }
    }
  }

  return {
    text: texts.length > 0 ? texts.join('\n') : undefined,
    toolUse: tools.length > 0 ? tools.join('\n') : undefined,
    toolResult: results.length > 0 ? results.join('\n') : undefined,
  };
}

export function createTelegramAdapter(config: Config, processManager: ProcessManager): { bot: Telegraf; pushHandler: PushHandler } {
  if (config.allowedUsers.length === 0) {
    throw new Error(
      'BARECLAW_ALLOWED_USERS is required when Telegram is enabled. ' +
      'BAREclaw has shell access — an open bot is an open door to your machine.'
    );
  }

  // Telegraf kills handlers that exceed handlerTimeout. Since BAREclaw sessions
  // are persistent and agentic responses can take minutes, this must be Infinity.
  const bot = new Telegraf(config.telegramToken!, {
    handlerTimeout: Infinity,
  });

  bot.catch((err) => {
    console.error(`[telegram] unhandled error: ${err instanceof Error ? err.message : err}`);
  });

  bot.on('text', async (ctx) => {
    const userId = ctx.from.id;

    if (!config.allowedUsers.includes(userId)) {
      console.log(`[telegram] blocked message from user ${userId}`);
      return;
    }

    const text = ctx.message.text;
    console.log(`[telegram] <- user ${userId}: ${text.substring(0, 80)}${text.length > 80 ? '...' : ''}`);

    // Show typing indicator
    await ctx.sendChatAction('typing');
    const typingInterval = setInterval(() => {
      ctx.sendChatAction('typing').catch(() => {});
    }, 4000);

    try {
      // Chain intermediate sends to preserve ordering
      let sendChain = Promise.resolve();
      let sentIntermediate = false;

      const channel = `tg-${ctx.chat.id}`;
      const response = await processManager.send(channel, text, (event: ClaudeEvent) => {
        const { text: assistantText, toolUse, toolResult } = extractContent(event);

        if (assistantText) {
          sentIntermediate = true;
          sendChain = sendChain.then(() => sendHtml(ctx, escapeHtml(assistantText))).catch((err) => {
            console.error(`[telegram] failed to send intermediate text: ${err}`);
          });
        }

        if (toolUse) {
          sendChain = sendChain.then(() => sendHtml(ctx, toolUse)).catch((err) => {
            console.error(`[telegram] failed to send tool notification: ${err}`);
          });
        }

        if (toolResult) {
          const preview = toolResult.length > 2000 ? toolResult.substring(0, 2000) + '...' : toolResult;
          sendChain = sendChain.then(() => sendHtml(ctx, `<blockquote expandable><pre>${escapeHtml(preview)}</pre></blockquote>`)).catch((err) => {
            console.error(`[telegram] failed to send tool result: ${err}`);
          });
        }
      });

      // Wait for all intermediate messages to flush
      await sendChain;
      clearInterval(typingInterval);

      // Message was folded into a subsequent queued message — don't send a response
      if (response.coalesced) return;

      console.log(`[telegram] -> user ${userId}: ${response.duration_ms}ms`);

      // Only send final result if we didn't already stream content
      if (!sentIntermediate) {
        await sendHtml(ctx, escapeHtml(response.text));
      }
    } catch (err) {
      clearInterval(typingInterval);
      const message = err instanceof Error ? err.message : 'Unknown error';
      console.error(`[telegram] error: ${message}`);
      await ctx.reply(`Error: ${message}`).catch(() => {});
    }
  });

  const pushHandler: PushHandler = async (channel, text) => {
    const chatId = parseInt(channel.slice(3), 10);
    if (!Number.isFinite(chatId)) {
      console.error(`[telegram] invalid chat ID in channel: ${channel}`);
      return false;
    }

    try {
      for (const chunk of splitText(text)) {
        await bot.telegram.sendMessage(chatId, chunk, { parse_mode: 'HTML' })
          .catch(() => bot.telegram.sendMessage(chatId, chunk.replace(/<[^>]*>/g, '')));
      }
      console.log(`[telegram] push -> ${channel}: ${text.substring(0, 80)}${text.length > 80 ? '...' : ''}`);
      return true;
    } catch (err) {
      console.error(`[telegram] push failed for ${channel}: ${err instanceof Error ? err.message : err}`);
      return false;
    }
  };

  return { bot, pushHandler };
}
