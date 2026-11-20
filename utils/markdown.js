/**
 * 轻量 Markdown → rich-text nodes
 * 只覆盖对话里常见的语法：标题、粗体、斜体、行内代码、代码块、列表、引用、分割线、链接。
 * 输出 rich-text 支持的节点对象（不用 HTML 字符串，避免转义问题）。
 */

const S = {
  p: 'margin:0 0 10rpx;line-height:1.65;',
  h1: 'font-size:36rpx;font-weight:700;margin:18rpx 0 10rpx;line-height:1.4;',
  h2: 'font-size:32rpx;font-weight:700;margin:16rpx 0 8rpx;line-height:1.4;',
  h3: 'font-size:30rpx;font-weight:600;margin:14rpx 0 8rpx;line-height:1.4;',
  codeBlock: 'display:block;background:rgba(255,255,255,0.07);border-radius:10rpx;padding:14rpx 18rpx;margin:10rpx 0;font-family:Menlo,Consolas,monospace;font-size:24rpx;white-space:pre-wrap;word-break:break-all;',
  inlineCode: 'background:rgba(255,255,255,0.1);border-radius:6rpx;padding:1rpx 8rpx;font-family:Menlo,Consolas,monospace;font-size:24rpx;',
  quote: 'display:block;border-left:4rpx solid #6ea8fe;padding-left:16rpx;margin:10rpx 0;color:#9a9aa6;',
  list: 'margin:8rpx 0;padding-left:36rpx;',
  li: 'margin:4rpx 0;line-height:1.6;',
  hr: 'border-top:1rpx solid rgba(255,255,255,0.15);margin:16rpx 0;',
  link: 'color:#6ea8fe;'
};

function text(value) {
  return { type: 'text', text: String(value) };
}

function el(name, children, style) {
  const node = { name: name, children: children || [] };
  if (style) node.attrs = { style: style };
  return node;
}

// 外层只保留一个捕获组，split 才能把分隔符一起保留
const INLINE_RE = /(`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\n]+\*|\[[^\]\n]+\]\([^)\s]+\))/g;

/** 行内语法解析 */
function inline(src) {
  const out = [];
  String(src).split(INLINE_RE).forEach((part) => {
    if (!part) return;
    if (part.length > 2 && part.charAt(0) === '`' && part.charAt(part.length - 1) === '`') {
      out.push(el('code', [text(part.slice(1, -1))], S.inlineCode));
      return;
    }
    if ((part.startsWith('**') && part.endsWith('**')) || (part.startsWith('__') && part.endsWith('__'))) {
      out.push(el('strong', [text(part.slice(2, -2))]));
      return;
    }
    if (part.length > 2 && part.charAt(0) === '*' && part.charAt(part.length - 1) === '*') {
      out.push(el('em', [text(part.slice(1, -1))]));
      return;
    }
    const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(part);
    if (link) {
      out.push(el('a', [text(link[1])], S.link));
      return;
    }
    out.push(text(part));
  });
  return out;
}

/** 多行文本合并为段落，保留软换行 */
function paragraph(lines) {
  const children = [];
  lines.forEach((line, idx) => {
    if (idx) children.push({ name: 'br' });
    children.push.apply(children, inline(line));
  });
  return el('p', children, S.p);
}

/**
 * @param {string} src markdown 原文
 * @returns {Array} rich-text nodes
 */
function toNodes(src) {
  const lines = String(src || '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let para = [];
  let i = 0;

  function flush() {
    if (para.length) {
      out.push(paragraph(para));
      para = [];
    }
  }

  while (i < lines.length) {
    const line = lines[i];

    // 代码块 ```
    if (/^```/.test(line)) {
      flush();
      const buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++; // 跳过闭合围栏
      out.push(el('code', [text(buf.join('\n'))], S.codeBlock));
      continue;
    }

    if (!line.trim()) {
      flush();
      i++;
      continue;
    }

    // 标题
    const head = /^(#{1,6})\s+(.*)$/.exec(line);
    if (head) {
      flush();
      const level = Math.min(3, head[1].length);
      out.push(el('h' + level, inline(head[2]), S['h' + level]));
      i++;
      continue;
    }

    // 分割线
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      flush();
      out.push(el('hr', [], S.hr));
      i++;
      continue;
    }

    // 引用
    if (/^\s*>\s?/.test(line)) {
      flush();
      const buf = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      out.push(el('blockquote', inline(buf.join(' ')), S.quote));
      continue;
    }

    // 列表（连续同类项合并）
    const isUl = /^\s*[-*+]\s+/.test(line);
    const isOl = /^\s*\d+[.)]\s+/.test(line);
    if (isUl || isOl) {
      flush();
      const itemRe = isUl ? /^\s*[-*+]\s+(.*)$/ : /^\s*\d+[.)]\s+(.*)$/;
      const items = [];
      while (i < lines.length) {
        const item = itemRe.exec(lines[i]);
        if (!item) break;
        items.push(el('li', inline(item[1]), S.li));
        i++;
      }
      out.push(el(isOl ? 'ol' : 'ul', items, S.list));
      continue;
    }

    para.push(line);
    i++;
  }

  flush();
  return out;
}

module.exports = { toNodes: toNodes };
