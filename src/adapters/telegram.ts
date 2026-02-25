/**
 * Telegram adapter — reference implementation for BAREclaw adapters.
 *
 * Channel key: `tg-<chatId>` — one channel per Telegram chat.
 *
 * UX design: minimize noise, maximize signal.
 * - One live "status" message updates in-place with tool activity
 * - Edits/Writes get their own messages with collapsible diffs
 * - Questions (AskUserQuestion) get their own messages
 * - Final result sent as the actual response
 * - Short filler text ("Let me check that") is suppressed
 */
import { Telegraf } from 'telegraf';
import type { Context } from 'telegraf';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { Config } from '../config.js';
import type { ProcessManager, MessageContent } from '../core/process-manager.js';
import type { ChannelContext, ClaudeEvent, ContentBlock, PushHandler } from '../core/types.js';

const MAX_MESSAGE_LENGTH = 4096;
const FILLER_MAX_LENGTH = 100;

/** Escape special HTML characters */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Convert markdown to Telegram-compatible HTML.
 *
 * Handles: fenced code blocks, inline code, bold, italic, strikethrough,
 * links, and headers. Everything else passes through as escaped text.
 */
export function markdownToHtml(md: string): string {
  // Extract fenced code blocks first to protect them from inline processing
  const codeBlocks: string[] = [];
  const withPlaceholders = md.replace(/```(\w*)\n([\s\S]*?)```/g, (_match, lang, code) => {
    const idx = codeBlocks.length;
    const escaped = escapeHtml(code.replace(/\n$/, ''));
    codeBlocks.push(lang
      ? `<pre><code class="language-${escapeHtml(lang)}">${escaped}</code></pre>`
      : `<pre>${escaped}</pre>`);
    return `\x00CODEBLOCK${idx}\x00`;
  });

  // Process each line (for headers) then inline formatting
  const lines = withPlaceholders.split('\n');
  const processed = lines.map(line => {
    // Check for code block placeholder — pass through untouched
    if (line.match(/^\x00CODEBLOCK\d+\x00$/)) return line;

    // Headers → bold
    const headerMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headerMatch) {
      return `<b>${convertInline(headerMatch[2])}</b>`;
    }

    return convertInline(line);
  });

  let result = processed.join('\n');

  // Restore code blocks
  for (let i = 0; i < codeBlocks.length; i++) {
    result = result.replace(`\x00CODEBLOCK${i}\x00`, codeBlocks[i]);
  }

  return result;
}

/** Convert inline markdown (bold, italic, code, links, strikethrough) */
function convertInline(text: string): string {
  // Extract inline code first to protect from other processing
  const inlineCode: string[] = [];
  let s = text.replace(/`([^`]+)`/g, (_match, code) => {
    const idx = inlineCode.length;
    inlineCode.push(`<code>${escapeHtml(code)}</code>`);
    return `\x00INLINE${idx}\x00`;
  });

  // Escape HTML in remaining text
  s = escapeHtml(s);

  // Bold: **text** or __text__
  s = s.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  s = s.replace(/__(.+?)__/g, '<b>$1</b>');

  // Italic: *text* or _text_ (but not inside words for _)
  s = s.replace(/\*(.+?)\*/g, '<i>$1</i>');
  s = s.replace(/(?<!\w)_(.+?)_(?!\w)/g, '<i>$1</i>');

  // Strikethrough: ~~text~~
  s = s.replace(/~~(.+?)~~/g, '<s>$1</s>');

  // Links: [text](url)
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // Restore inline code
  for (let i = 0; i < inlineCode.length; i++) {
    s = s.replace(`\x00INLINE${i}\x00`, inlineCode[i]);
  }

  return s;
}

/** Split text into chunks that fit Telegram's message limit */
export function splitText(text: string): string[] {
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

// Internal tools — never shown in the status line
export const HIDDEN_TOOLS = new Set([
  'EnterPlanMode', 'ExitPlanMode', 'Task', 'TaskCreate',
  'TaskUpdate', 'TaskList', 'TaskGet',
  'TodoWrite', 'TodoRead', 'WebSearch', 'WebFetch',
  'ToolSearch', 'NotebookEdit', 'ListMcpResourcesTool', 'ReadMcpResourceTool',
  'Skill',
]);

/** Format an Edit tool call as a collapsible diff */
export function formatDiff(input: Record<string, unknown>): string {
  const file = escapeHtml(String(input.file_path || 'unknown'));
  const old = escapeHtml(String(input.old_string || ''));
  const new_ = escapeHtml(String(input.new_string || ''));
  const diffLines: string[] = [];
  for (const line of old.split('\n')) diffLines.push('- ' + line);
  for (const line of new_.split('\n')) diffLines.push('+ ' + line);
  return `<code>Edit: ${file}</code>\n<blockquote expandable><pre>${diffLines.join('\n')}</pre></blockquote>`;
}

/** Format a Write tool call as a collapsible preview */
export function formatWrite(input: Record<string, unknown>): string {
  const file = escapeHtml(String(input.file_path || 'unknown'));
  const content = escapeHtml(String(input.content || ''));
  const preview = content.length > 1000 ? content.substring(0, 1000) + '...' : content;
  return `<code>Write: ${file}</code>\n<blockquote expandable><pre>${preview}</pre></blockquote>`;
}

/** Format an AskUserQuestion tool call */
export function formatQuestion(input: Record<string, unknown>): string {
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

/** Check if text is short filler ("Let me read that.", "I'll check this.") */
export function isFiller(text: string): boolean {
  return text.length < FILLER_MAX_LENGTH && !text.includes('\n') && !text.includes('```');
}

/**
 * Tracks tool activity for a single turn and manages an in-place status message.
 */
class StatusLine {
  private ctx: Context;
  private messageId: number | null = null;
  private tools: string[] = [];
  private pending: Promise<void> = Promise.resolve();

  constructor(ctx: Context) {
    this.ctx = ctx;
  }

  /** Add a tool to the status line and update the message */
  addTool(name: string, target?: string) {
    const label = target ? `${name}: ${target}` : name;
    this.tools.push(label);
    this.pending = this.pending.then(() => this.update()).catch(() => {});
  }

  /** Wait for all pending updates to flush */
  async flush() {
    await this.pending;
  }

  /** Reset the status line so the next tool creates a fresh message */
  reset() {
    this.pending = this.pending.then(() => {});
    this.messageId = null;
    this.tools = [];
  }

  private async update() {
    const text = this.tools.map(t => `<code>${escapeHtml(t)}</code>`).join('\n');
    if (text.length === 0) return;

    try {
      if (this.messageId) {
        await this.ctx.telegram.editMessageText(
          this.ctx.chat!.id, this.messageId, undefined, text,
          { parse_mode: 'HTML' }
        ).catch(() => {});
      } else {
        const msg = await this.ctx.reply(text, { parse_mode: 'HTML' });
        this.messageId = msg.message_id;
      }
    } catch {}
  }
}

const MEDIA_DIR = join(homedir(), '.bareclaw', 'media');
const MAX_FILE_SIZE = 20 * 1024 * 1024; // Telegram bot API limit is 20MB

/** Map file extensions to MIME types for common Telegram media */
export function mimeFromExt(ext: string): string {
  const map: Record<string, string> = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
    '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
    '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.avi': 'video/x-msvideo',
    '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.oga': 'audio/ogg',
    '.wav': 'audio/wav', '.flac': 'audio/flac', '.m4a': 'audio/mp4',
    '.pdf': 'application/pdf', '.zip': 'application/zip',
    '.tgs': 'application/x-tgsticker', '.webm': 'video/webm',
  };
  return map[ext.toLowerCase()] || 'application/octet-stream';
}

/** Get file extension from a URL or filename */
export function extFromUrl(url: string): string {
  const match = url.match(/\.(\w+)(?:\?|$)/);
  return match ? `.${match[1]}` : '';
}

interface DownloadedFile {
  path: string;
  buffer: Buffer;
  ext: string;
  mime: string;
}

/**
 * Download a Telegram file to ~/.bareclaw/media/<channel>/.
 * Returns the local path, buffer, extension, and MIME type.
 */
export async function downloadTelegramFile(
  ctx: Context,
  fileId: string,
  channel: string,
  opts?: { fileName?: string; ext?: string }
): Promise<DownloadedFile> {
  const fileLink = await ctx.telegram.getFileLink(fileId);
  const url = fileLink.toString();
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Failed to download file: ${resp.status}`);

  const contentLength = parseInt(resp.headers.get('content-length') || '0', 10);
  if (contentLength > MAX_FILE_SIZE) {
    throw new Error(`File too large (${(contentLength / 1024 / 1024).toFixed(1)}MB, max ${MAX_FILE_SIZE / 1024 / 1024}MB)`);
  }

  const buffer = Buffer.from(await resp.arrayBuffer());
  if (buffer.length > MAX_FILE_SIZE) {
    throw new Error(`File too large (${(buffer.length / 1024 / 1024).toFixed(1)}MB, max ${MAX_FILE_SIZE / 1024 / 1024}MB)`);
  }

  const ext = opts?.ext || extFromUrl(url) || '.bin';
  const mime = mimeFromExt(ext);
  const timestamp = Date.now();
  const safeName = opts?.fileName
    ? opts.fileName.replace(/[^a-zA-Z0-9._-]/g, '_')
    : `file${ext}`;
  const fileName = `${timestamp}-${safeName}`;

  const dir = join(MEDIA_DIR, channel);
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, fileName);
  await writeFile(filePath, buffer);

  return { path: filePath, buffer, ext, mime };
}

export function createTelegramAdapter(config: Config, processManager: ProcessManager): { bot: Telegraf; pushHandler: PushHandler } {
  if (config.allowedUsers.length === 0) {
    throw new Error(
      'BARECLAW_ALLOWED_USERS is required when Telegram is enabled. ' +
      'BAREclaw has shell access — an open bot is an open door to your machine.'
    );
  }

  const bot = new Telegraf(config.telegramToken!, {
    handlerTimeout: Infinity,
  });

  bot.catch((err) => {
    console.error(`[telegram] unhandled error: ${err instanceof Error ? err.message : err}`);
  });

  async function handleMessage(ctx: Context, content: MessageContent, logLabel: string): Promise<void> {
    const userId = ctx.from!.id;

    if (!config.allowedUsers.includes(userId)) {
      console.log(`[telegram] blocked message from user ${userId}`);
      return;
    }

    console.log(`[telegram] <- user ${userId}: ${logLabel}`);

    await ctx.sendChatAction('typing');
    const typingInterval = setInterval(() => {
      ctx.sendChatAction('typing').catch(() => {});
    }, 4000);

    try {
      let sendChain = Promise.resolve();
      let compacting = false;
      let sentStreamed = false;
      const status = new StatusLine(ctx);

      const msg = ctx.message as Record<string, unknown> | undefined;
      const threadId = msg?.message_thread_id as number | undefined;
      const channel = threadId ? `tg-${ctx.chat!.id}-${threadId}` : `tg-${ctx.chat!.id}`;
      const context: ChannelContext = {
        channel,
        adapter: 'telegram',
        userName: ctx.from ? [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ') : undefined,
        chatTitle: ctx.chat!.type !== 'private' ? (ctx.chat as { title?: string }).title : undefined,
        topicName: threadId ? String(threadId) : undefined,
      };
      const response = await processManager.send(channel, content, context, (event: ClaudeEvent) => {
        if (event.type === 'system' && event.subtype === 'compact_boundary') {
          compacting = true;
          return;
        }
        if (compacting) {
          // Compaction is over once Claude produces new output
          if (event.type === 'assistant') {
            compacting = false;
          } else {
            return;
          }
        }
        if (event.type !== 'assistant' || !event.message?.content) return;

        for (const block of event.message.content) {
          if (block.type === 'text' && block.text?.trim()) {
            // Skip filler — only send substantial text
            if (!isFiller(block.text)) {
              sentStreamed = true;
              sendChain = sendChain
                .then(() => status.flush())
                .then(() => sendHtml(ctx, markdownToHtml(block.text!)))
                .then(() => status.reset())
                .catch((err) => console.error(`[telegram] send error: ${err}`));
            }
          } else if (block.type === 'tool_use' && block.name && !HIDDEN_TOOLS.has(block.name)) {
            const input = block.input as Record<string, unknown> | undefined;

            if (block.name === 'Edit' && input) {
              // Rich message: collapsible diff
              sendChain = sendChain
                .then(() => status.flush())
                .then(() => sendHtml(ctx, formatDiff(input!)))
                .then(() => status.reset())
                .catch((err) => console.error(`[telegram] send error: ${err}`));
            } else if (block.name === 'Write' && input) {
              // Rich message: collapsible file preview
              sendChain = sendChain
                .then(() => status.flush())
                .then(() => sendHtml(ctx, formatWrite(input!)))
                .then(() => status.reset())
                .catch((err) => console.error(`[telegram] send error: ${err}`));
            } else if (block.name === 'AskUserQuestion' && input) {
              // Rich message: question with options
              sendChain = sendChain
                .then(() => status.flush())
                .then(() => sendHtml(ctx, formatQuestion(input!)))
                .then(() => status.reset())
                .catch((err) => console.error(`[telegram] send error: ${err}`));
            } else {
              // Status line: compact tool indicator
              const target = input?.file_path || input?.path || input?.pattern || input?.command;
              status.addTool(block.name!, target ? String(target) : undefined);
            }
          }
        }
      });

      await sendChain;
      await status.flush();
      clearInterval(typingInterval);

      if (response.coalesced) return;

      console.log(`[telegram] -> user ${userId}: ${response.duration_ms}ms`);

      // Send the final result only if we didn't already stream it
      // Skip error results (session ended, crash) — not useful to the user
      if (!sentStreamed && !compacting && !response.is_error && response.text.trim()) {
        await sendHtml(ctx, markdownToHtml(response.text));
      }
    } catch (err) {
      clearInterval(typingInterval);
      const message = err instanceof Error ? err.message : 'Unknown error';
      console.error(`[telegram] error: ${message}`);
      await ctx.reply(`Error: ${message}`).catch(() => {});
    }
  }

  bot.on('text', async (ctx) => {
    const text = ctx.message.text;
    const label = text.substring(0, 80) + (text.length > 80 ? '...' : '');
    await handleMessage(ctx, text, label);
  });

  /** Derive the channel key for a context (used by media handlers for file storage) */
  function channelFor(ctx: Context): string {
    const msg = ctx.message as Record<string, unknown> | undefined;
    const threadId = msg?.message_thread_id as number | undefined;
    return threadId ? `tg-${ctx.chat!.id}-${threadId}` : `tg-${ctx.chat!.id}`;
  }

  /** Wrap a media handler with auth check + error handling */
  function mediaHandler<T extends Context>(type: string, handler: (ctx: T) => Promise<void>) {
    return async (ctx: T) => {
      if (!config.allowedUsers.includes(ctx.from!.id)) {
        console.log(`[telegram] blocked ${type} from user ${ctx.from!.id}`);
        return;
      }
      try {
        await handler(ctx);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        console.error(`[telegram] ${type} error: ${message}`);
        await ctx.reply(`Error processing ${type}: ${message}`).catch(() => {});
      }
    };
  }

  // --- Photos: base64 for Claude vision + saved to disk ---
  bot.on('photo', mediaHandler('photo', async (ctx) => {
    const channel = channelFor(ctx);
    const photo = ctx.message.photo[ctx.message.photo.length - 1];
    const file = await downloadTelegramFile(ctx, photo.file_id, channel, { ext: '.jpg' });

    const base64Data = file.buffer.toString('base64');
    const mediaType = file.ext === '.png' ? 'image/png'
      : file.ext === '.gif' ? 'image/gif'
      : file.ext === '.webp' ? 'image/webp'
      : 'image/jpeg';

    const caption = ctx.message.caption || 'What do you see in this image?';
    const content: ContentBlock[] = [
      { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64Data } },
      { type: 'text', text: `${caption}\n\n(saved to ${file.path})` },
    ];
    await handleMessage(ctx, content, `[photo] ${caption.substring(0, 60)}`);
  }));

  // --- Documents: any file type ---
  bot.on('document', mediaHandler('document', async (ctx) => {
    const channel = channelFor(ctx);
    const doc = ctx.message.document;
    const ext = doc.file_name ? extFromUrl(doc.file_name) || '.bin' : '.bin';
    const file = await downloadTelegramFile(ctx, doc.file_id, channel, {
      fileName: doc.file_name || undefined,
      ext,
    });

    const caption = ctx.message.caption || '';
    const isImage = file.mime.startsWith('image/');

    if (isImage) {
      // Render images inline for Claude vision
      const base64Data = file.buffer.toString('base64');
      const content: ContentBlock[] = [
        { type: 'image', source: { type: 'base64', media_type: file.mime, data: base64Data } },
        { type: 'text', text: `${caption || 'Image file received.'}\n\n(saved to ${file.path})` },
      ];
      await handleMessage(ctx, content, `[document:image] ${(doc.file_name || 'image').substring(0, 60)}`);
    } else {
      const sizeKb = (file.buffer.length / 1024).toFixed(1);
      const text = [
        caption,
        `File received: ${doc.file_name || 'unnamed'} (${sizeKb} KB, ${file.mime})`,
        `Saved to: ${file.path}`,
      ].filter(Boolean).join('\n');
      await handleMessage(ctx, text, `[document] ${(doc.file_name || 'file').substring(0, 60)}`);
    }
  }));

  // --- Voice messages ---
  bot.on('voice', mediaHandler('voice', async (ctx) => {
    const channel = channelFor(ctx);
    const voice = ctx.message.voice;
    const file = await downloadTelegramFile(ctx, voice.file_id, channel, { ext: '.ogg' });

    const duration = voice.duration;
    const text = [
      ctx.message.caption || '',
      `Voice message received (${duration}s, ${(file.buffer.length / 1024).toFixed(1)} KB)`,
      `Saved to: ${file.path}`,
    ].filter(Boolean).join('\n');
    await handleMessage(ctx, text, `[voice] ${duration}s`);
  }));

  // --- Audio files ---
  bot.on('audio', mediaHandler('audio', async (ctx) => {
    const channel = channelFor(ctx);
    const audio = ctx.message.audio;
    const ext = audio.file_name ? extFromUrl(audio.file_name) || '.mp3' : '.mp3';
    const file = await downloadTelegramFile(ctx, audio.file_id, channel, {
      fileName: audio.file_name || undefined,
      ext,
    });

    const parts = [ctx.message.caption || ''];
    if (audio.title) parts.push(`Title: ${audio.title}`);
    if (audio.performer) parts.push(`Artist: ${audio.performer}`);
    parts.push(`Audio file (${audio.duration}s, ${(file.buffer.length / 1024).toFixed(1)} KB, ${file.mime})`);
    parts.push(`Saved to: ${file.path}`);

    await handleMessage(ctx, parts.filter(Boolean).join('\n'), `[audio] ${(audio.title || audio.file_name || 'audio').substring(0, 60)}`);
  }));

  // --- Video files ---
  bot.on('video', mediaHandler('video', async (ctx) => {
    const channel = channelFor(ctx);
    const video = ctx.message.video;
    const ext = video.file_name ? extFromUrl(video.file_name) || '.mp4' : '.mp4';
    const file = await downloadTelegramFile(ctx, video.file_id, channel, {
      fileName: video.file_name || undefined,
      ext,
    });

    const caption = ctx.message.caption || '';
    const text = [
      caption,
      `Video received (${video.duration}s, ${video.width}x${video.height}, ${(file.buffer.length / 1024).toFixed(1)} KB)`,
      `Saved to: ${file.path}`,
    ].filter(Boolean).join('\n');
    await handleMessage(ctx, text, `[video] ${(video.file_name || 'video').substring(0, 60)}`);
  }));

  // --- Video notes (circular video messages) ---
  bot.on('video_note', mediaHandler('video_note', async (ctx) => {
    const channel = channelFor(ctx);
    const vn = ctx.message.video_note;
    const file = await downloadTelegramFile(ctx, vn.file_id, channel, { ext: '.mp4' });

    const text = [
      `Video note received (${vn.duration}s, ${(file.buffer.length / 1024).toFixed(1)} KB)`,
      `Saved to: ${file.path}`,
    ].join('\n');
    await handleMessage(ctx, text, `[video_note] ${vn.duration}s`);
  }));

  // --- Stickers ---
  bot.on('sticker', mediaHandler('sticker', async (ctx) => {
    const channel = channelFor(ctx);
    const sticker = ctx.message.sticker;
    const ext = sticker.is_animated ? '.tgs' : sticker.is_video ? '.webm' : '.webp';
    const file = await downloadTelegramFile(ctx, sticker.file_id, channel, { ext });

    const isStaticImage = !sticker.is_animated && !sticker.is_video;
    if (isStaticImage) {
      const base64Data = file.buffer.toString('base64');
      const content: ContentBlock[] = [
        { type: 'image', source: { type: 'base64', media_type: 'image/webp', data: base64Data } },
        { type: 'text', text: `Sticker: ${sticker.emoji || ''} (set: ${sticker.set_name || 'unknown'})\n\n(saved to ${file.path})` },
      ];
      await handleMessage(ctx, content, `[sticker] ${sticker.emoji || sticker.set_name || 'sticker'}`);
    } else {
      const text = [
        `Sticker received: ${sticker.emoji || ''} (${sticker.is_animated ? 'animated' : 'video'}, set: ${sticker.set_name || 'unknown'})`,
        `Saved to: ${file.path}`,
      ].join('\n');
      await handleMessage(ctx, text, `[sticker] ${sticker.emoji || 'sticker'}`);
    }
  }));

  // --- Animations (GIFs) ---
  bot.on('animation', mediaHandler('animation', async (ctx) => {
    const channel = channelFor(ctx);
    const anim = ctx.message.animation;
    const ext = anim.file_name ? extFromUrl(anim.file_name) || '.mp4' : '.mp4';
    const file = await downloadTelegramFile(ctx, anim.file_id, channel, {
      fileName: anim.file_name || undefined,
      ext,
    });

    const caption = ctx.message.caption || '';
    const text = [
      caption,
      `GIF/animation received (${anim.duration}s, ${anim.width}x${anim.height}, ${(file.buffer.length / 1024).toFixed(1)} KB)`,
      `Saved to: ${file.path}`,
    ].filter(Boolean).join('\n');
    await handleMessage(ctx, text, `[animation] ${(anim.file_name || 'animation').substring(0, 60)}`);
  }));

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
