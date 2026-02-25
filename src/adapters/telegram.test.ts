import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import {
  escapeHtml,
  markdownToHtml,
  splitText,
  isFiller,
  formatDiff,
  formatWrite,
  formatQuestion,
  HIDDEN_TOOLS,
  mimeFromExt,
  extFromUrl,
  downloadTelegramFile,
} from './telegram.js';

describe('escapeHtml', () => {
  it('escapes ampersands', () => {
    expect(escapeHtml('a & b')).toBe('a &amp; b');
  });

  it('escapes angle brackets', () => {
    expect(escapeHtml('<script>alert("xss")</script>')).toBe(
      '&lt;script&gt;alert("xss")&lt;/script&gt;'
    );
  });

  it('handles already-safe text', () => {
    expect(escapeHtml('hello world')).toBe('hello world');
  });

  it('escapes all three in sequence', () => {
    expect(escapeHtml('a < b & c > d')).toBe('a &lt; b &amp; c &gt; d');
  });
});

describe('markdownToHtml', () => {
  it('converts bold', () => {
    expect(markdownToHtml('**hello**')).toBe('<b>hello</b>');
  });

  it('converts italic with asterisks', () => {
    expect(markdownToHtml('*hello*')).toBe('<i>hello</i>');
  });

  it('converts inline code', () => {
    expect(markdownToHtml('use `npm install`')).toBe('use <code>npm install</code>');
  });

  it('converts fenced code blocks', () => {
    const result = markdownToHtml('```ts\nconst x = 1;\n```');
    expect(result).toContain('<pre>');
    expect(result).toContain('const x = 1;');
    expect(result).toContain('language-ts');
  });

  it('converts fenced code blocks without language', () => {
    const result = markdownToHtml('```\nhello\n```');
    expect(result).toBe('<pre>hello</pre>');
  });

  it('converts links', () => {
    expect(markdownToHtml('[click](https://example.com)')).toBe(
      '<a href="https://example.com">click</a>'
    );
  });

  it('converts headers to bold', () => {
    expect(markdownToHtml('## Summary')).toBe('<b>Summary</b>');
  });

  it('converts strikethrough', () => {
    expect(markdownToHtml('~~old~~')).toBe('<s>old</s>');
  });

  it('escapes HTML in regular text', () => {
    expect(markdownToHtml('a < b & c > d')).toBe('a &lt; b &amp; c &gt; d');
  });

  it('escapes HTML inside code blocks', () => {
    const result = markdownToHtml('```\n<script>alert("xss")</script>\n```');
    expect(result).toContain('&lt;script&gt;');
  });

  it('escapes HTML inside inline code', () => {
    expect(markdownToHtml('`<b>not bold</b>`')).toBe('<code>&lt;b&gt;not bold&lt;/b&gt;</code>');
  });

  it('handles mixed formatting', () => {
    const result = markdownToHtml('**bold** and `code` and *italic*');
    expect(result).toBe('<b>bold</b> and <code>code</code> and <i>italic</i>');
  });

  it('handles plain text without markdown', () => {
    expect(markdownToHtml('just plain text')).toBe('just plain text');
  });

  it('handles multiline with mixed content', () => {
    const input = '# Title\n\nSome **bold** text.\n\n```\ncode here\n```';
    const result = markdownToHtml(input);
    expect(result).toContain('<b>Title</b>');
    expect(result).toContain('<b>bold</b>');
    expect(result).toContain('<pre>code here</pre>');
  });
});

describe('splitText', () => {
  it('returns single chunk for short text', () => {
    expect(splitText('hello')).toEqual(['hello']);
  });

  it('splits at 4096 chars', () => {
    const text = 'a'.repeat(5000);
    const parts = splitText(text);
    expect(parts).toHaveLength(2);
    expect(parts[0]).toHaveLength(4096);
    expect(parts[1]).toHaveLength(904);
  });

  it('handles exactly 4096 chars', () => {
    const text = 'x'.repeat(4096);
    expect(splitText(text)).toHaveLength(1);
  });

  it('handles empty string', () => {
    expect(splitText('')).toEqual(['']);
  });
});

describe('isFiller', () => {
  it('detects short single-line text as filler', () => {
    expect(isFiller('Let me check that.')).toBe(true);
    expect(isFiller("I'll read the file.")).toBe(true);
  });

  it('rejects multiline text', () => {
    expect(isFiller('line one\nline two')).toBe(false);
  });

  it('rejects text with code blocks', () => {
    expect(isFiller('here is ```code```')).toBe(false);
  });

  it('rejects long text', () => {
    expect(isFiller('a'.repeat(100))).toBe(false);
  });

  it('accepts text just under the limit', () => {
    expect(isFiller('a'.repeat(99))).toBe(true);
  });
});

describe('formatDiff', () => {
  it('formats old and new strings as a diff', () => {
    const result = formatDiff({
      file_path: 'src/foo.ts',
      old_string: 'const x = 1;',
      new_string: 'const x = 2;',
    });
    expect(result).toContain('Edit: src/foo.ts');
    expect(result).toContain('- const x = 1;');
    expect(result).toContain('+ const x = 2;');
  });

  it('escapes HTML in file paths', () => {
    const result = formatDiff({
      file_path: 'src/<script>.ts',
      old_string: '',
      new_string: '',
    });
    expect(result).toContain('&lt;script&gt;');
    expect(result).not.toContain('<script>');
  });

  it('handles missing fields gracefully', () => {
    const result = formatDiff({});
    expect(result).toContain('Edit: unknown');
  });
});

describe('formatWrite', () => {
  it('formats a file write with preview', () => {
    const result = formatWrite({
      file_path: 'src/new.ts',
      content: 'export const x = 1;',
    });
    expect(result).toContain('Write: src/new.ts');
    expect(result).toContain('export const x = 1;');
  });

  it('truncates long content', () => {
    const result = formatWrite({
      file_path: 'big.txt',
      content: 'x'.repeat(2000),
    });
    expect(result).toContain('...');
  });

  it('handles missing fields', () => {
    const result = formatWrite({});
    expect(result).toContain('Write: unknown');
  });
});

describe('formatQuestion', () => {
  it('formats a question with options', () => {
    const result = formatQuestion({
      questions: [{
        question: 'Which database?',
        options: [
          { label: 'PostgreSQL', description: 'Relational' },
          { label: 'MongoDB', description: 'Document store' },
        ],
      }],
    });
    expect(result).toContain('Which database?');
    expect(result).toContain('1. PostgreSQL');
    expect(result).toContain('2. MongoDB');
    expect(result).toContain('Relational');
  });

  it('handles empty questions array', () => {
    expect(formatQuestion({ questions: [] })).toBe('<code>AskUserQuestion</code>');
  });

  it('handles missing questions', () => {
    expect(formatQuestion({})).toBe('<code>AskUserQuestion</code>');
  });
});

describe('HIDDEN_TOOLS', () => {
  it('contains plan mode tools', () => {
    expect(HIDDEN_TOOLS.has('EnterPlanMode')).toBe(true);
    expect(HIDDEN_TOOLS.has('ExitPlanMode')).toBe(true);
  });

  it('contains task tools', () => {
    expect(HIDDEN_TOOLS.has('Task')).toBe(true);
    expect(HIDDEN_TOOLS.has('TodoWrite')).toBe(true);
    expect(HIDDEN_TOOLS.has('TodoRead')).toBe(true);
  });

  it('contains web tools', () => {
    expect(HIDDEN_TOOLS.has('WebSearch')).toBe(true);
    expect(HIDDEN_TOOLS.has('WebFetch')).toBe(true);
  });

  it('contains MCP tools', () => {
    expect(HIDDEN_TOOLS.has('ToolSearch')).toBe(true);
    expect(HIDDEN_TOOLS.has('ListMcpResourcesTool')).toBe(true);
    expect(HIDDEN_TOOLS.has('ReadMcpResourceTool')).toBe(true);
  });

  it('does NOT contain user-visible tools', () => {
    expect(HIDDEN_TOOLS.has('Read')).toBe(false);
    expect(HIDDEN_TOOLS.has('Bash')).toBe(false);
    expect(HIDDEN_TOOLS.has('Edit')).toBe(false);
    expect(HIDDEN_TOOLS.has('Write')).toBe(false);
    expect(HIDDEN_TOOLS.has('Grep')).toBe(false);
    expect(HIDDEN_TOOLS.has('Glob')).toBe(false);
  });
});

// --- Media file handling ---

describe('mimeFromExt', () => {
  it('maps common image extensions', () => {
    expect(mimeFromExt('.jpg')).toBe('image/jpeg');
    expect(mimeFromExt('.jpeg')).toBe('image/jpeg');
    expect(mimeFromExt('.png')).toBe('image/png');
    expect(mimeFromExt('.gif')).toBe('image/gif');
    expect(mimeFromExt('.webp')).toBe('image/webp');
    expect(mimeFromExt('.bmp')).toBe('image/bmp');
  });

  it('maps video extensions', () => {
    expect(mimeFromExt('.mp4')).toBe('video/mp4');
    expect(mimeFromExt('.mov')).toBe('video/quicktime');
    expect(mimeFromExt('.webm')).toBe('video/webm');
  });

  it('maps audio extensions', () => {
    expect(mimeFromExt('.mp3')).toBe('audio/mpeg');
    expect(mimeFromExt('.ogg')).toBe('audio/ogg');
    expect(mimeFromExt('.wav')).toBe('audio/wav');
    expect(mimeFromExt('.flac')).toBe('audio/flac');
    expect(mimeFromExt('.m4a')).toBe('audio/mp4');
  });

  it('maps document extensions', () => {
    expect(mimeFromExt('.pdf')).toBe('application/pdf');
    expect(mimeFromExt('.zip')).toBe('application/zip');
    expect(mimeFromExt('.tgs')).toBe('application/x-tgsticker');
  });

  it('is case-insensitive', () => {
    expect(mimeFromExt('.JPG')).toBe('image/jpeg');
    expect(mimeFromExt('.PNG')).toBe('image/png');
    expect(mimeFromExt('.MP4')).toBe('video/mp4');
  });

  it('returns octet-stream for unknown extensions', () => {
    expect(mimeFromExt('.xyz')).toBe('application/octet-stream');
    expect(mimeFromExt('.foo')).toBe('application/octet-stream');
    expect(mimeFromExt('')).toBe('application/octet-stream');
  });
});

describe('extFromUrl', () => {
  it('extracts extension from simple URLs', () => {
    expect(extFromUrl('https://example.com/file.jpg')).toBe('.jpg');
    expect(extFromUrl('https://example.com/path/to/doc.pdf')).toBe('.pdf');
  });

  it('extracts extension from URLs with query strings', () => {
    expect(extFromUrl('https://cdn.telegram.org/file/photo.jpg?token=abc')).toBe('.jpg');
  });

  it('extracts extension from filenames', () => {
    expect(extFromUrl('report.pdf')).toBe('.pdf');
    expect(extFromUrl('song.mp3')).toBe('.mp3');
  });

  it('returns empty string when no extension found', () => {
    expect(extFromUrl('https://example.com/noext')).toBe('');
    expect(extFromUrl('')).toBe('');
  });

  it('handles multiple dots in path', () => {
    expect(extFromUrl('https://example.com/file.backup.tar.gz')).toBe('.gz');
  });
});

describe('downloadTelegramFile', () => {
  const MEDIA_DIR = join(homedir(), '.bareclaw', 'media');
  const TEST_CHANNEL = 'tg-test-download';
  const testDir = join(MEDIA_DIR, TEST_CHANNEL);

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function mockCtx(url: string) {
    return {
      telegram: {
        getFileLink: vi.fn().mockResolvedValue(new URL(url)),
      },
    } as any;
  }

  function mockFetch(body: Buffer | string, headers: Record<string, string> = {}) {
    const buf = typeof body === 'string' ? Buffer.from(body) : body;
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      headers: new Headers(headers),
      arrayBuffer: () => Promise.resolve(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)),
    } as any);
  }

  it('downloads a file and saves to disk', async () => {
    const ctx = mockCtx('https://cdn.telegram.org/file/photo.jpg');
    const payload = Buffer.from('fake image data');
    mockFetch(payload);

    const result = await downloadTelegramFile(ctx, 'file-123', TEST_CHANNEL, { ext: '.jpg' });

    expect(result.buffer).toEqual(payload);
    expect(result.ext).toBe('.jpg');
    expect(result.mime).toBe('image/jpeg');
    expect(result.path).toMatch(new RegExp(`${TEST_CHANNEL}/\\d+-file\\.jpg$`));

    // Verify file actually written to disk
    const ondisk = await readFile(result.path);
    expect(ondisk).toEqual(payload);
  });

  it('uses original filename when provided', async () => {
    const ctx = mockCtx('https://cdn.telegram.org/file/abc123');
    mockFetch('hello');

    const result = await downloadTelegramFile(ctx, 'f1', TEST_CHANNEL, {
      fileName: 'report.pdf',
      ext: '.pdf',
    });

    expect(result.path).toContain('report.pdf');
    expect(result.mime).toBe('application/pdf');
  });

  it('sanitizes unsafe characters in filenames', async () => {
    const ctx = mockCtx('https://cdn.telegram.org/file/x');
    mockFetch('data');

    const result = await downloadTelegramFile(ctx, 'f1', TEST_CHANNEL, {
      fileName: '../etc/passwd',
      ext: '.txt',
    });

    // Slashes are replaced with _, preventing path traversal
    const filename = result.path.split('/').pop()!;
    expect(filename).not.toContain('/');
    expect(filename).toContain('.._etc_passwd');
    // File still lands in the expected directory
    expect(result.path).toMatch(new RegExp(`${TEST_CHANNEL}/`));
  });

  it('falls back to extension from URL when no ext option given', async () => {
    const ctx = mockCtx('https://cdn.telegram.org/file/thing.png');
    mockFetch('px');

    const result = await downloadTelegramFile(ctx, 'f1', TEST_CHANNEL);

    expect(result.ext).toBe('.png');
    expect(result.mime).toBe('image/png');
  });

  it('falls back to .bin when no extension anywhere', async () => {
    const ctx = mockCtx('https://cdn.telegram.org/file/noext');
    mockFetch('bytes');

    const result = await downloadTelegramFile(ctx, 'f1', TEST_CHANNEL);

    expect(result.ext).toBe('.bin');
    expect(result.mime).toBe('application/octet-stream');
  });

  it('throws on HTTP error', async () => {
    const ctx = mockCtx('https://cdn.telegram.org/file/x');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, status: 404 } as any);

    await expect(downloadTelegramFile(ctx, 'f1', TEST_CHANNEL))
      .rejects.toThrow('Failed to download file: 404');
  });

  it('rejects files over 20MB by content-length', async () => {
    const ctx = mockCtx('https://cdn.telegram.org/file/big.zip');
    const headers = { 'content-length': String(25 * 1024 * 1024) };
    mockFetch('small', headers);

    await expect(downloadTelegramFile(ctx, 'f1', TEST_CHANNEL, { ext: '.zip' }))
      .rejects.toThrow(/too large/i);
  });

  it('rejects files over 20MB by actual buffer size', async () => {
    const ctx = mockCtx('https://cdn.telegram.org/file/big.bin');
    const huge = Buffer.alloc(21 * 1024 * 1024);
    // No content-length header — size check happens after download
    mockFetch(huge);

    await expect(downloadTelegramFile(ctx, 'f1', TEST_CHANNEL, { ext: '.bin' }))
      .rejects.toThrow(/too large/i);
  });
});
