// mend-fast: a faster drop-in for makefun-site 1.0.0 (site-generator-speed-01).
// Written from the makefun-site README and reference code, with the same answers
// byte for byte, but with the hot paths rebuilt: single-pass Markdown rendering,
// run-copy inline rendering (no per-character escaping), cached slugs and dates,
// allocation-light front-matter scanning, and a template interpreter that renders
// into one shared output array with reusable loop frames.
//
// Entry: run(input) -> the output tree { path: text }.

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const RESERVED = ['posts', 'tags', 'page'];

// ------------------------------------------------------------------ text

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Fast HTML escape: copy runs of plain text, replace only the five specials. */
function esc(text, a = 0, b = text.length) {
  let out = '';
  let i = a;
  while (i < b) {
    let j = i;
    while (j < b) {
      const c = text.charCodeAt(j);
      if (c === 38 || c === 60 || c === 62 || c === 34 || c === 39) break;
      j++;
    }
    if (j > i) out += text.slice(i, j);
    if (j >= b) break;
    out += ESCAPES[text[j]];
    i = j + 1;
  }
  return out;
}

/** \s per JavaScript: a 64 KiB lookup table of the whitespace code points. */
const WS_TABLE = new Uint8Array(65536);
for (const c of [9, 10, 11, 12, 13, 32, 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff]) WS_TABLE[c] = 1;
for (let c = 0x2000; c <= 0x200a; c++) WS_TABLE[c] = 1;

function isWs(code) {
  return WS_TABLE[code] === 1;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** Per-run caches: slugify/longDate results, keyed by the input string. */
let slugCache;
let dateCache;

function slugify(text) {
  const hit = slugCache.get(text);
  if (hit !== undefined) return hit;
  const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, 64).replace(/-+$/, '');
  const res = out === '' ? 'untitled' : out;
  slugCache.set(text, res);
  return res;
}

function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

function longDate(date) {
  const hit = dateCache.get(date);
  if (hit !== undefined) return hit;
  const [y, m, d] = date.split('-');
  const res = `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
  dateCache.set(date, res);
  return res;
}

/** Word count: runs of non-whitespace, counted without allocating the matches. */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    if (isWs(text.charCodeAt(i))) inWord = false;
    else if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
}

function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

// ------------------------------------------------------------------ front matter

const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAME_RE = /^[a-z0-9-]+$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG_RE = /^[^"[\]]+$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function isKeyChar(c) {
  return (c >= 'a' && c <= 'z') || c === '_';
}

function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = DATE_RE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !TAG_RE.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return NAME_RE.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUG_RE.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * Front matter and body, or { error }. Scans lines by index (no split of the
 * whole text, no re-join of the body): the body is a slice of the input.
 */
function parseFrontMatter(text) {
  const firstNL = text.indexOf('\n');
  const firstLine = firstNL === -1 ? text : text.slice(0, firstNL);
  if (firstLine !== '---') return { error: 'no front matter' };
  // Find the closing --- line, tracking line numbers (line 1 is the opener).
  let pos = firstNL === -1 ? text.length : firstNL + 1;
  let lineNo = 1;
  let closeLine = -1;
  let closeEnd = -1;
  while (pos <= text.length) {
    const nl = text.indexOf('\n', pos);
    const end = nl === -1 ? text.length : nl;
    lineNo++;
    if (text.slice(pos, end) === '---') {
      closeLine = lineNo;
      closeEnd = nl === -1 ? text.length : nl + 1;
      break;
    }
    pos = nl === -1 ? text.length + 1 : nl + 1;
  }
  if (closeLine === -1) return { error: 'the front matter is not closed' };
  const data = {};
  // Walk the lines between the opener and the closer.
  pos = firstNL + 1;
  lineNo = 1;
  while (pos < closeEnd) {
    const nl = text.indexOf('\n', pos);
    const end = nl === -1 ? text.length : nl;
    const line = text.slice(pos, end);
    lineNo++;
    if (lineNo === closeLine) break;
    if (line === '' || /^[ \t]+$/.test(line) || line.charCodeAt(0) === 35) {
      pos = nl === -1 ? text.length + 1 : nl + 1;
      continue;
    }
    const colon = line.indexOf(':');
    let key = null;
    let raw = null;
    if (colon > 0) {
      let ok = true;
      for (let k = 0; k < colon; k++) if (!isKeyChar(line[k])) { ok = false; break; }
      if (ok) {
        key = line.slice(0, colon);
        if (colon + 1 === line.length) raw = '';
        else if (line.charCodeAt(colon + 1) === 32) raw = line.slice(colon + 2);
      }
    }
    if (key === null) return { error: `line ${lineNo} is not "key: value"` };
    // Trailing spaces/tabs dropped from the value.
    let e = raw.length;
    while (e > 0 && (raw.charCodeAt(e - 1) === 32 || raw.charCodeAt(e - 1) === 9)) e--;
    raw = raw.slice(0, e);
    if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
    pos = nl === -1 ? text.length + 1 : nl + 1;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(closeEnd) };
}

// ------------------------------------------------------------------ markdown

const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

function isBlankLine(s, a, b) {
  for (let i = a; i < b; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function trimBounds(s, a, b) {
  while (a < b && (s.charCodeAt(a) === 32 || s.charCodeAt(a) === 9)) a++;
  while (b > a && (s.charCodeAt(b - 1) === 32 || s.charCodeAt(b - 1) === 9)) b--;
  return [a, b];
}

/** Fence opener at [a,b): ``` + lang [A-Za-z0-9_+-]* + spaces/tabs; lang or null. */
function fenceOpen(s, a, b) {
  if (b - a < 3 || s.charCodeAt(a) !== 96 || s.charCodeAt(a + 1) !== 96 || s.charCodeAt(a + 2) !== 96) return null;
  let i = a + 3;
  while (i < b) {
    const c = s.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) i++;
    else break;
  }
  const lang = s.slice(a + 3, i);
  while (i < b && (s.charCodeAt(i) === 32 || s.charCodeAt(i) === 9)) i++;
  return i === b ? lang : null;
}

function fenceClose(s, a, b) {
  if (b - a < 3 || s.charCodeAt(a) !== 96 || s.charCodeAt(a + 1) !== 96 || s.charCodeAt(a + 2) !== 96) return false;
  for (let i = a + 3; i < b; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** Heading at [a,b): 1-6 #, space/tab, non-empty text; { depth, text } or null. */
function headingOf(s, a, b) {
  let i = a;
  while (i < b && s.charCodeAt(i) === 35) i++;
  const n = i - a;
  if (n === 0 || n > 6) return null;
  if (i >= b || (s.charCodeAt(i) !== 32 && s.charCodeAt(i) !== 9)) return null;
  while (i < b && (s.charCodeAt(i) === 32 || s.charCodeAt(i) === 9)) i++;
  const [ta, tb] = trimBounds(s, i, b);
  if (ta === tb) return null;
  return { depth: n, text: s.slice(ta, tb) };
}

function isHr(s, a, b) {
  if (b - a < 3) return false;
  const dash = s.charCodeAt(a) === 45 && s.charCodeAt(a + 1) === 45 && s.charCodeAt(a + 2) === 45;
  const star = s.charCodeAt(a) === 42 && s.charCodeAt(a + 1) === 42 && s.charCodeAt(a + 2) === 42;
  if (!dash && !star) return false;
  for (let i = a + 3; i < b; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function endsParagraph(s, a, b) {
  return isBlankLine(s, a, b) || fenceOpen(s, a, b) !== null || headingOf(s, a, b) !== null || isHr(s, a, b);
}

/** First index >= from where `what` occurs outside a backslash escape, or -1. */
function findUnescaped(s, what, from, end = s.length) {
  const wlen = what.length;
  for (let j = from; j <= end - wlen; j++) {
    if (s.charCodeAt(j) === 92 && j + 1 < end && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** First single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from, end = s.length) {
  for (let j = from; j < end; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < end && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== '*') continue;
    if (j + 1 < end && s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/**
 * Inline rendering. Copies runs of plain text verbatim; only the inline
 * markers (` \ ` * [ and the five HTML specials) are handled one by one.
 * `link` resolves a link target to its href.
 */
function inline(s, link, out, a = 0, b = s.length) {
  let i = a;
  while (i < b) {
    let j = i;
    while (j < b) {
      const c = s.charCodeAt(j);
      if (c === 92 || c === 96 || c === 42 || c === 91 || c === 38 || c === 60 || c === 62 || c === 34 || c === 39) break;
      j++;
    }
    if (j > i) out.s += s.slice(i, j);
    if (j >= b) break;
    i = j;
    const c = s[i];
    if (c === '\\' && i + 1 < b && ESCAPABLE.has(s[i + 1])) {
      const nx = s[i + 1];
      out.s += ESCAPES[nx] ?? nx;
      i += 2;
      continue;
    }
    if (c === '`') {
      const k = s.indexOf('`', i + 1);
      if (k !== -1 && k < b && k > i + 1) {
        out.s += '<code>';
        out.s += esc(s, i + 1, k);
        out.s += '</code>';
        i = k + 1;
      } else {
        out.s += '`';
        i++;
      }
      continue;
    }
    if (c === '*') {
      if (i + 1 < b && s[i + 1] === '*') {
        const k = findUnescaped(s, '**', i + 2, b);
        if (k > i + 2) {
          out.s += '<strong>';
          inline(s, link, out, i + 2, k);
          out.s += '</strong>';
          i = k + 2;
        } else {
          out.s += '**';
          i += 2;
        }
        continue;
      }
      const k = findSingleStar(s, i + 1, b);
      if (k > i + 1) {
        out.s += '<em>';
        inline(s, link, out, i + 1, k);
        out.s += '</em>';
        i = k + 1;
      } else {
        out.s += '*';
        i++;
      }
      continue;
    }
    if (c === '[') {
      const k = findUnescaped(s, ']', i + 1, b);
      const m = k !== -1 && k + 1 < b && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = m === -1 || m >= b ? '' : s.slice(k + 2, m);
      if (target !== '' && !/\s/.test(target)) {
        out.s += '<a href="';
        out.s += esc(link(target));
        out.s += '">';
        inline(s, link, out, i + 1, k);
        out.s += '</a>';
        i = m + 1;
        continue;
      }
      out.s += '[';
      i++;
      continue;
    }
    out.s += ESCAPES[c] ?? c;
    i++;
  }
}

/** Inline rendering into a fresh string (a shared scratch array, single-threaded). */
const INLINE_SCRATCH = { s: '' };
function inlineStr(s, link) {
  INLINE_SCRATCH.s = '';
  inline(s, link, INLINE_SCRATCH);
  return INLINE_SCRATCH.s;
}

/**
 * Render `src` to { html, toc, excerpt }: one pass over its lines, blocks
 * rendered straight into the output array (no token list).
 */
function renderMarkdown(src, link) {
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  const n = src.length;
  let pos = 0;
  // Line iterator: [a,b) bounds of the current line; a trailing empty line
  // after a final "\n" is a real line, as in String.split("\n").
  while (pos <= n) {
    const nl = src.indexOf('\n', pos);
    const a = pos;
    const b = nl === -1 ? n : nl;
    const next = nl === -1 ? n + 1 : nl + 1;
    if (isBlankLine(src, a, b)) {
      pos = next;
      continue;
    }
    const lang = fenceOpen(src, a, b);
    if (lang !== null) {
      const body = [];
      pos = next;
      while (pos <= n) {
        const nl2 = src.indexOf('\n', pos);
        const a2 = pos;
        const b2 = nl2 === -1 ? n : nl2;
        if (fenceClose(src, a2, b2)) {
          pos = nl2 === -1 ? n + 1 : nl2 + 1;
          break;
        }
        body.push(src.slice(a2, b2));
        pos = nl2 === -1 ? n + 1 : nl2 + 1;
      }
      const cls = lang === '' ? '' : ` class="language-${lang}"`;
      let code = '';
      for (const l of body) code += `${esc(l)}\n`;
      blocks.push(`<pre><code${cls}>${code}</code></pre>`);
      continue;
    }
    const heading = headingOf(src, a, b);
    if (heading !== null) {
      const id = uniqueSlug(slugify(heading.text), ids);
      const html = inlineStr(heading.text, link);
      blocks.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>`);
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
      pos = next;
      continue;
    }
    if (isHr(src, a, b)) {
      blocks.push('<hr>');
      pos = next;
      continue;
    }
    if (src.charCodeAt(a) === 62) {
      // Blockquote: consecutive lines opening on '>'.
      const lines = [];
      while (pos <= n) {
        const nl2 = src.indexOf('\n', pos);
        const a2 = pos;
        const b2 = nl2 === -1 ? n : nl2;
        if (src.charCodeAt(a2) !== 62) break;
        let s2 = a2 + 1;
        if (s2 < b2 && src.charCodeAt(s2) === 32) s2++;
        const [ta, tb] = trimBounds(src, s2, b2);
        if (ta !== tb) lines.push(src.slice(ta, tb));
        pos = nl2 === -1 ? n + 1 : nl2 + 1;
      }
      blocks.push(lines.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${inlineStr(lines.join('\n'), link)}</p>\n</blockquote>`);
      continue;
    }
    // List: bullet "- "/"* " or ordered "N. ".
    let isOrdered = false;
    let startNum = 1;
    let firstItem = null;
    const c0 = src.charCodeAt(a);
    if ((c0 === 45 || c0 === 42) && a + 1 < b && src.charCodeAt(a + 1) === 32) {
      firstItem = src.slice(a + 2, b);
    } else if (c0 >= 48 && c0 <= 57) {
      let d = a;
      while (d < b && src.charCodeAt(d) >= 48 && src.charCodeAt(d) <= 57) d++;
      if (d - a >= 1 && d - a <= 9 && d + 1 < b && src.charCodeAt(d) === 46 && src.charCodeAt(d + 1) === 32) {
        isOrdered = true;
        startNum = Number(src.slice(a, d));
        firstItem = src.slice(d + 2, b);
      }
    }
    if (firstItem !== null) {
      const items = [];
      let cur = [trimStr(firstItem)];
      pos = next;
      const markerBullet = !isOrdered;
      while (pos <= n) {
        const nl2 = src.indexOf('\n', pos);
        const a2 = pos;
        const b2 = nl2 === -1 ? n : nl2;
        let mItem = null;
        if (markerBullet) {
          const cc = src.charCodeAt(a2);
          if ((cc === 45 || cc === 42) && a2 + 1 < b2 && src.charCodeAt(a2 + 1) === 32) mItem = src.slice(a2 + 2, b2);
        } else {
          const cc = src.charCodeAt(a2);
          if (cc >= 48 && cc <= 57) {
            let d = a2;
            while (d < b2 && src.charCodeAt(d) >= 48 && src.charCodeAt(d) <= 57) d++;
            if (d - a2 >= 1 && d - a2 <= 9 && d + 1 < b2 && src.charCodeAt(d) === 46 && src.charCodeAt(d + 1) === 32) mItem = src.slice(d + 2, b2);
          }
        }
        if (mItem !== null) {
          items.push(cur);
          cur = [trimStr(mItem)];
          pos = nl2 === -1 ? n + 1 : nl2 + 1;
          continue;
        }
        // Continuation: two or more spaces, then a non-space character.
        let sp = a2;
        while (sp < b2 && src.charCodeAt(sp) === 32) sp++;
        if (sp - a2 >= 2 && sp < b2 && !isWs(src.charCodeAt(sp))) {
          const [ta, tb] = trimBounds(src, a2, b2);
          cur.push(src.slice(ta, tb));
          pos = nl2 === -1 ? n + 1 : nl2 + 1;
          continue;
        }
        break;
      }
      items.push(cur);
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && startNum !== 1 ? `<ol start="${startNum}">` : `<${tag}>`;
      let lis = '';
      for (const parts of items) lis += `<li>${inlineStr(parts.join('\n'), link)}</li>\n`;
      blocks.push(`${open}\n${lis}</${tag}>`);
      continue;
    }
    // Paragraph: lines up to a blank line, fence, heading or thematic break.
    {
      const [ta, tb] = trimBounds(src, a, b);
      const parts = [src.slice(ta, tb)];
      pos = next;
      while (pos <= n) {
        const nl2 = src.indexOf('\n', pos);
        const a2 = pos;
        const b2 = nl2 === -1 ? n : nl2;
        if (endsParagraph(src, a2, b2)) break;
        const [ta2, tb2] = trimBounds(src, a2, b2);
        parts.push(src.slice(ta2, tb2));
        pos = nl2 === -1 ? n + 1 : nl2 + 1;
      }
      const html = inlineStr(parts.join('\n'), link);
      if (excerpt === null) excerpt = html;
      blocks.push(`<p>${html}</p>`);
    }
  }
  let html = '';
  for (const x of blocks) html += x + '\n';
  return { html, toc, excerpt: excerpt ?? '' };
}

function trimStr(s) {
  let a = 0;
  let b = s.length;
  while (a < b && (s.charCodeAt(a) === 32 || s.charCodeAt(a) === 9)) a++;
  while (b > a && (s.charCodeAt(b - 1) === 32 || s.charCodeAt(b - 1) === 9)) b--;
  return s.slice(a, b);
}

// ------------------------------------------------------------------ templates

const INCLUDE_DEPTH = 8;
const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

class TemplateError extends Error {}

function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/**
 * Render `nodes` into the shared output array `out`. A for-loop reuses one
 * frame (and one loop object) across its iterations instead of allocating a
 * scope per element.
 */
function renderNodes(nodes, scope, ctx, depth, out) {
  for (let ni = 0; ni < nodes.length; ni++) {
    const n = nodes[ni];
    if (n.kind === 'text') {
      out.s += n.text;
    } else if (n.kind === 'var') {
      out.s += esc(textOf(lookup(scope, n.path)));
    } else if (n.kind === 'raw') {
      out.s += textOf(lookup(scope, n.path));
    } else if (n.kind === 'if') {
      const branch = truthy(lookup(scope, n.path)) !== n.not ? n.then : n.else;
      if (branch !== null) renderNodes(branch, scope, ctx, depth, out);
    } else if (n.kind === 'for') {
      const xs = lookup(scope, n.path);
      if (!Array.isArray(xs)) continue;
      const vars = {};
      const loop = { index: 0, first: false, last: false, length: xs.length };
      vars[n.name] = undefined;
      vars.loop = loop;
      const frame = { vars, parent: scope };
      for (let k = 0; k < xs.length; k++) {
        vars[n.name] = xs[k];
        loop.index = k + 1;
        loop.first = k === 0;
        loop.last = k === xs.length - 1;
        renderNodes(n.body, frame, ctx, depth, out);
      }
    } else if (n.kind === 'include') {
      const t = ctx.templates.get(n.name);
      if (t === undefined || depth >= INCLUDE_DEPTH) continue;
      // Memoized includes: 'nav' and 'header' read only site/recent (constant
      // for the case); 'card' reads only its post card, the same object wherever
      // it appears. Their output is a pure function of that data within a case.
      // Only at depth 0, where the include chain cannot have cut anything off.
      if (depth === 0 && (n.name === 'nav' || n.name === 'header')) {
        let hit = ctx.memo.get(n.name);
        if (hit === undefined) {
          const tmp = { s: '' };
          renderNodes(t, scope, ctx, depth + 1, tmp);
          hit = tmp.s;
          ctx.memo.set(n.name, hit);
        }
        out.s += hit;
      } else if (depth === 0 && n.name === 'card') {
        const p = lookup(scope, ['p']);
        if (p !== null && typeof p === 'object') {
          let hit = ctx.memo.get(p);
          if (hit === undefined) {
            const tmp = { s: '' };
            renderNodes(t, scope, ctx, depth + 1, tmp);
            hit = tmp.s;
            ctx.memo.set(p, hit);
          }
          out.s += hit;
        } else {
          renderNodes(t, scope, ctx, depth + 1, out);
        }
      } else {
        renderNodes(t, scope, ctx, depth + 1, out);
      }
    }
  }
}

// ------------------------------------------------------------------ the build

const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });

function cardOf(s) {
  if (s._card !== undefined) return s._card;
  const c = {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  };
  s._card = c;
  return c;
}

function pageOf(s) {
  const c = cardOf(s);
  return {
    ...c,
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  };
}

export function run(input) {
  slugCache = new Map();
  dateCache = new Map();
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const b = {
    input,
    base: input.site.base_url.replace(/\/+$/, ''),
    templates,
    sources: [],
    statics: [],
    bySource: new Map(),
    broken: new Set(),
    report,
    posts: [],
    tags: [],
    cards: new Map(),
    output: {},
  };

  // 1. Sources, sorted by path in code-unit order; .md is a source, else static.
  {
    const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
    for (const f of files) {
      if (f.path.endsWith('.md')) b.sources.push({ path: f.path, text: f.content.replace(/\r\n?/g, '\n') });
      else b.statics.push({ path: f.path, content: f.content });
    }
  }

  // 2. Front matter, in the reference's check order.
  {
    const kept = [];
    for (const s of b.sources) {
      const fm = parseFrontMatter(s.text);
      if ('error' in fm) {
        b.report.push(`refused ${s.path}: ${fm.error}`);
        continue;
      }
      s.data = fm.data;
      s.body = fm.body;
      s.post = s.path.startsWith('posts/');
      let own;
      if (s.path.startsWith('tags/')) own = 'tags';
      else if (s.path.startsWith('page/')) own = 'page';
      if (own !== undefined) {
        b.report.push(`refused ${s.path}: ${own}/ is the generator's own`);
        continue;
      }
      if (s.post && !Object.hasOwn(s.data, 'date')) {
        b.report.push(`refused ${s.path}: a post needs a date`);
        continue;
      }
      const layout = s.data.layout ?? (s.post ? 'post' : 'page');
      if (!b.templates.has(layout)) {
        b.report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
        continue;
      }
      s.layout = layout;
      if (s.data.draft === true) {
        b.report.push(`draft ${s.path}`);
        continue;
      }
      kept.push(s);
    }
    b.sources = kept;
  }

  // 3. Permalinks: slugs unique in their directory, in source order.
  {
    const taken = new Map();
    const takenIn = (dir) => {
      if (!taken.has(dir)) taken.set(dir, new Set(dir === '' ? RESERVED : []));
      return taken.get(dir);
    };
    for (const s of b.sources) {
      const dir = s.post ? 'posts' : dirOf(s.path);
      const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), takenIn(dir));
      s.slug = slug;
      s.outDir = dir === '' ? slug : `${dir}/${slug}`;
      s.url = `${b.base}/${s.outDir}/`;
      b.bySource.set(s.path, s);
    }
  }

  // 4. Markdown, links resolved.
  {
    const staticPaths = new Set(b.statics.map((f) => f.path));
    for (const s of b.sources) {
      const dir = dirOf(s.path);
      const link = (target) => {
        if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && b.bySource.has(path)) return `${b.bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${b.base}/${path}${frag}`;
        b.broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      };
      const md = renderMarkdown(s.body, link);
      s.html = md.html;
      s.toc = md.toc;
      s.excerpt = md.excerpt;
    }
  }

  // 5. Collections: posts newest first, then by slug; newer/older neighbours.
  {
    const posts = b.sources.filter((s) => s.post);
    posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
    b.posts = posts;
    posts.forEach((p, k) => {
      p.newer = k === 0 ? null : posts[k - 1];
      p.older = k === posts.length - 1 ? null : posts[k + 1];
    });
  }

  // 6. Tags, grouped by slug, ordered by count then slug.
  {
    const bySlug = new Map();
    const ownTags = (s) => {
      const seen = new Set();
      const out = [];
      for (const name of s.data.tags ?? []) {
        const slug = slugify(name);
        if (!seen.has(slug)) {
          seen.add(slug);
          out.push(name);
        }
      }
      return out;
    };
    for (const p of b.posts) {
      p.tagRefs = [];
      for (const name of ownTags(p)) {
        const slug = slugify(name);
        if (!bySlug.has(slug)) bySlug.set(slug, { name, slug, url: `${b.base}/tags/${slug}/`, posts: [] });
        const tag = bySlug.get(slug);
        tag.posts.push(p);
        p.tagRefs.push(tag);
      }
    }
    for (const s of b.sources) {
      if (!s.post) s.tagRefs = ownTags(s).map((name) => bySlug.get(slugify(name)) ?? { name, slug: slugify(name), url: '', posts: [] });
    }
    b.tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));
  }

  // 7. Layouts: every page, the index pages, the tag pages, then statics.
  {
    b.cards = new Map(b.posts.map((p) => [p, cardOf(p)]));
    const site = { title: b.input.site.title, base_url: b.base };
    const allTags = b.tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
    const recent = b.posts.slice(0, b.input.site.recent).map((p) => b.cards.get(p));
    const ctx = { templates: b.templates, memo: new Map() };
    const render = (name, vars) => {
      const nodes = b.templates.get(name);
      if (nodes === undefined) return null;
      const out = { s: '' };
      renderNodes(nodes, { vars: { site, tags: allTags, recent, ...vars }, parent: null }, ctx, 0, out);
      return out.s;
    };
    const tagOf = (t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => b.cards.get(p)) });
    for (const s of b.sources) b.output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
    const per = b.input.site.per_page;
    const pages = Math.max(1, Math.ceil(b.posts.length / per));
    const indexUrl = (k) => (k === 1 ? `${b.base}/` : `${b.base}/page/${k}/`);
    for (let k = 1; k <= pages; k++) {
      const html = render('index', {
        posts: b.posts.slice((k - 1) * per, k * per).map((p) => b.cards.get(p)),
        pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
      });
      if (html !== null) b.output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
    }
    for (const t of b.tags) {
      const html = render('tag', { tag: tagOf(t) });
      if (html !== null) b.output[`tags/${t.slug}/index.html`] = html;
    }
    const tagsHtml = render('tags', {});
    if (tagsHtml !== null) b.output['tags/index.html'] = tagsHtml;
    for (const f of b.statics) {
      if (Object.hasOwn(b.output, f.path)) b.report.push(`shadowed ${f.path}: a built page has its path`);
      else b.output[f.path] = f.content;
    }
  }

  // 8. The report.
  {
    const lines = [...b.report, ...b.broken].sort(byCodeUnits);
    const pages = b.sources.filter((s) => !s.post).length;
    lines.push(`built ${pages} pages, ${b.posts.length} posts, ${b.tags.length} tags and ${b.statics.length} static files`);
    b.output['build-report.txt'] = `${lines.join('\n')}\n`;
  }

  return b.output;
}
