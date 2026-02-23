import { describe, it, expect } from 'vitest';
import {
  escapeHtml,
  markdownToHtml,
  splitText,
  isFiller,
  formatDiff,
  formatWrite,
  formatQuestion,
  HIDDEN_TOOLS,
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
