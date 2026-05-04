// HTML string builder for the static and dynamic export modes.
//
// The app has two parallel rendering paths that produce the same HTML structure
// and use the same CSS class names:
//
//   render.js (this file)   — string-based; used by the static and dynamic exports
//   components/Block.jsx    — SolidJS components; used by the live SPA and full-featured export
//
// The static export is why the string builder exists at all: it must produce
// zero-JS HTML with no hydration markers, which rules out renderToString().
//
// The dynamic export reuses the string builder for session content (since it already
// exists), then adds a ~500-byte vanilla script for theme switching. Theme switching
// is a single attribute swap (data-theme on :root) — it doesn't benefit from a
// reactive framework. Embedding the SolidJS bundle instead would just produce the
// full-featured export.
//
// The full-featured export doesn't use the string builder for session content at all:
// it inlines the production SolidJS bundle, which re-renders everything from embedded
// session JSON using the same Block.jsx components as the live SPA.
//
// Pure parsing helpers shared by both rendering paths live here and are imported by Block.jsx:
//   escapeHtml, renderInline, splitFencedBlocks, parseToolHeader
//
// CSS is imported via ?raw so it is always available as a string regardless of
// whether we are running under the Vite dev server or the production build.

import rawCSS from './style.css?raw'
import { THEMES, THEME_KEYS, themeToCSS, allThemesToCSS } from './themes.js'
import pkg from '../package.json'

const REPO_URL = pkg.repository

import iconsSvgRaw from './icons.svg?raw'

// Extract the path data for the GitHub mark at build time so it can be inlined
// without a network fetch. The regex skips any attributes between id= and d=
// using [\s\S]*? (non-greedy, crosses newlines). [1] is the first capture group.
export const GITHUB_ICON_PATH = iconsSvgRaw.match(/id="github"[\s\S]*?d="([^"]+)"/)[1]
const GITHUB_SVG = `<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="${GITHUB_ICON_PATH}"/></svg>`

// ---------------------------------------------------------------------------
// Minifiers
// ---------------------------------------------------------------------------

function minifyCSS(css) {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, '')     // strip block comments
    .replace(/[ \t]*\n[ \t]*/g, '\n')     // strip per-line indentation
    .replace(/\n{2,}/g, '\n')             // collapse blank lines
    .replace(/\n?([{};:,>~+])\n?/g, '$1') // strip newlines around punctuation
    .replace(/;}/g, '}')                  // drop trailing semicolons
    .trim()
}

function minifyHtml(html) {
  // Preserve verbatim blocks where whitespace is significant or content is
  // already minified by a dedicated minifier: <pre> (code blocks), <script>
  // (inline JS, which may contain session JSON with meaningful whitespace),
  // <style> (CSS already processed by minifyCSS), and inline-prose spans
  // (white-space:pre-wrap — padding spaces in box-drawing tables are significant).
  const preserved = []
  // Stash a verbatim block and return a null-byte sentinel (\x00p{i}\x00) as
  // its placeholder. Null bytes can't appear in well-formed HTML, so they
  // survive the whitespace normalization below without risk of collision.
  // The sentinels are swapped back for the originals at the end.
  const save = s => { preserved.push(s); return `\x00p${preserved.length - 1}\x00` }
  // Scripts and styles must be stashed before <pre> blocks: the bundle contains
  // <pre>...</pre> fragments inside template literals and regex literals, which
  // the lazy pre-stash regex would otherwise incorrectly match across them.
  let result = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, save)
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, save)
    .replace(/<pre\b[^>]*>[\s\S]*?<\/pre>/gi, save)
    .replace(/<span class="inline-prose">[\s\S]*?<\/span>/g, save)

  result = result
    .replace(/[ \t]+/g, ' ')  // collapse horizontal whitespace
    .replace(/\n\s*/g, '\n')  // strip leading whitespace from lines
    .replace(/\n{2,}/g, '\n') // collapse blank lines
    .trim()

  return result.replace(/\x00p(\d+)\x00/g, (_, i) => preserved[parseInt(i)])
}

// ---------------------------------------------------------------------------
// Inline markup: backtick code spans and fenced code blocks
// ---------------------------------------------------------------------------

export function escapeHtml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function renderInline(text) {
  return escapeHtml(text).replace(/`([^`]+)`/g, '<code>$1</code>')
}

// Splits text into alternating prose/fenced segments, tracking fence depth so
// that a nested ```lang inside an outer fence is treated as content, not a
// fence boundary. Outer fence markers are stripped; inner ones are preserved.
export function splitFencedBlocks(text) {
  const lines = text.split('\n')
  const segments = []
  let depth = 0
  let current = []

  const flush = (fenced) => {
    if (current.length > 0) segments.push({ fenced, content: current.join('\n') })
    current = []
  }

  for (const line of lines) {
    if (/^```/.test(line)) {
      if (/^```\w/.test(line)) {
        // ```lang — always an opening fence.
        if (depth === 0) flush(false)   // flush preceding prose segment
        depth++
        if (depth > 1) current.push(line)  // nested opener → treat as content
      } else {
        // bare ``` — closes the innermost open fence, or opens one at depth 0.
        if (depth === 0)      { flush(false); depth = 1 }      // anonymous open
        else if (depth === 1) { flush(true);  depth = 0 }      // close outermost → emit fenced segment
        else                  { current.push(line); depth-- }  // close inner fence → keep as content
      }
    } else {
      current.push(line)
    }
  }

  flush(depth > 0)
  return segments
}

export function renderText(text) {
  return splitFencedBlocks(text).map(seg =>
    seg.fenced
      ? `<pre class="fenced-block">${escapeHtml(seg.content)}</pre>`
      : `<span class="inline-prose">${renderInline(seg.content)}</span>`
  ).join('')
}

// ---------------------------------------------------------------------------
// Diff renderer
// ---------------------------------------------------------------------------

function renderDiffLine(line) {
  const num = `<span class="diff-line-num">${line.lineNum ? escapeHtml(line.lineNum) : ''}</span>`
  const prefix = line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' '
  const cls = line.type === 'raw' ? 'wrap' : line.type
  return (
    `<div class="diff-line ${cls}">` +
    num +
    `<span class="diff-line-content">` +
    `<span class="diff-type-char">${prefix}</span>` +
    escapeHtml(line.content) +
    `</span></div>`
  )
}

function renderDiff(lines) {
  return `<div class="diff-block"><div class="diff-inner">${lines.map(renderDiffLine).join('')}</div></div>`
}

// ---------------------------------------------------------------------------
// Block renderers
// ---------------------------------------------------------------------------

export function parseToolHeader(header) {
  const m = header.match(/^([A-Za-z_][\w.:]*)(\(.*)?$/)
  if (!m) return { name: header, args: '' }
  return { name: m[1], args: m[2] || '' }
}

function renderToolResult(result) {
  return (
    `<div class="tool-result">` +
    `<div class="tool-result-label"><span>${escapeHtml(result.text)}</span></div>` +
    (result.diff ? renderDiff(result.diff) : '') +
    `</div>`
  )
}

function renderBlock(block) {
  const isToolCall = block.blockType === 'tool-call'
  const { name, args } = parseToolHeader(block.header)

  const header = isToolCall
    ? `<span class="tool-name">${escapeHtml(name)}</span><span class="tool-args">${escapeHtml(args)}</span>`
    : `<span class="block-text-header">${renderInline(block.header)}</span>`

  return (
    `<div class="assistant-block block-${isToolCall ? 'tool' : 'text'}">` +
    `<div class="turn-gutter"><span class="turn-icon${isToolCall ? ' tool-icon' : ''}">●</span></div>` +
    `<div class="turn-body">` +
    `<div class="${isToolCall ? 'tool-header' : ''}">${header}</div>` +
    (block.body ? `<div class="block-text-body">${renderText(block.body)}</div>` : '') +
    block.toolResults.map(renderToolResult).join('') +
    `</div></div>`
  )
}

function renderEvent(event) {
  switch (event.type) {
    case 'header': {
      const m = event.meta
      const chips = [
        m.model   && `<span class="header-chip chip-model">${escapeHtml(m.model)}</span>`,
        m.plan    && `<span class="header-chip chip-plan">${escapeHtml(m.plan)}</span>`,
        m.version && `<span class="header-chip chip-version">v${escapeHtml(m.version)}</span>`,
      ].filter(Boolean).join('')
      const brandRow =
        `<div class="header-brand-row">` +
        `<span class="header-brand-mark">◆</span>` +
        `<span class="header-brand-name">claude session</span>` +
        `<div class="header-chips">${chips}</div>` +
        `</div>`
      const identityRow = (m.user || m.project)
        ? `<div class="header-identity-row">` +
          (m.user    ? `<span class="header-identity-user">${escapeHtml(m.user)}</span>` : '') +
          (m.user && m.project ? `<span class="header-identity-sep">·</span>` : '') +
          (m.project ? `<span class="header-identity-project" title="${escapeHtml(m.project)}">${escapeHtml(m.project)}</span>` : '') +
          `</div>`
        : ''
      return `<div class="block-header-meta">${brandRow}${identityRow}</div>`
    }
    case 'user': {
      const refs = event.fileRefs.length
        ? `<div class="user-filerefs">${event.fileRefs.map(r => `<span class="user-fileref">${escapeHtml(r)}</span>`).join('')}</div>`
        : ''
      return (
        `<div class="turn turn-user">` +
        `<div class="turn-gutter"><span class="turn-icon">❯</span></div>` +
        `<div class="turn-body"><div class="user-content">${renderText(event.content)}</div>${refs}</div>` +
        `</div>`
      )
    }
    case 'assistant':
      return `<div class="turn turn-assistant">${event.blocks.map(renderBlock).join('')}</div>`
    case 'thinking':
      return (
        `<div class="turn turn-thinking">` +
        `<div class="turn-gutter"></div>` +
        `<div class="turn-body"><span class="thinking-content">✻ ${escapeHtml(event.content)}</span></div>` +
        `</div>`
      )
    default:
      return ''
  }
}

function obsessionFooter(version = '') {
  return `<div class="obsession-footer">` +
    `<a href="https://specious.github.io/obsession/" target="_blank" rel="noopener">generated with obsession</a>` +
    (version ? `<span class="obsession-footer-version">v${version}</span>` : '') +
    `</div>`
}

function renderSession(events, version = '') {
  return events.map(renderEvent).join('\n') + '\n' + obsessionFooter(version)
}

// ---------------------------------------------------------------------------
// Static export — the only mode that requires the string builder.
// Zero JavaScript: session HTML is fully pre-rendered; chosen theme baked into :root.
// ---------------------------------------------------------------------------

// Topbar CSS in readable form; minifyCSS() collapses it for compact exports.
const TOPBAR_CSS = `
/* ---- Exported topbar ---- */
.exported-topbar {
  position: sticky;
  top: 0;
  z-index: 100;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 var(--gutter);
  height: 48px;
  background: var(--bg-2);
  border-bottom: 1px solid var(--border);
  font-family: system-ui, sans-serif;
  font-size: 13px;
}
.exported-topbar .brand { font-weight: 600; color: var(--fg); }
.exported-topbar .brand span { color: var(--user-accent); }
.theme-toggle-wrap { position: relative; margin-left: auto; }
#theme-toggle {
  display: flex;
  align-items: center;
  gap: 4px;
  height: 28px;
  padding: 0 10px;
  border-radius: 3px;
  border: 1px solid var(--border-2);
  background: transparent;
  color: var(--fg-2);
  cursor: pointer;
  font: inherit;
  font-size: 12px;
  width: 160px;
  overflow: hidden;
}
.btn-label {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  flex: 1 1 0;
  min-width: 0;
}
.btn-arrow { flex-shrink: 0; }
#theme-menu {
  display: none;
  position: absolute;
  right: 0;
  top: calc(100% + 6px);
  z-index: 200;
  background: var(--bg-2);
  border: 1px solid var(--border-2);
  border-radius: 6px;
  min-width: 180px;
  overflow: hidden;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
}
.theme-btn {
  display: block;
  width: 100%;
  text-align: left;
  padding: 8px 14px;
  cursor: pointer;
  border: none;
  background: transparent;
  font-family: system-ui, sans-serif;
  font-size: 13px;
  color: var(--fg-2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.theme-btn:hover,
.theme-btn.active { background: var(--bg-hover); color: var(--fg); }
.theme-btn.active { color: var(--user-accent); }
.exported-brand-col {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  flex-shrink: 1;
}
.exported-filename {
  font-size: 0.75rem;
  font-weight: 400;
  color: var(--fg-2);
  opacity: 0.6;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
}
@keyframes filename-copied {
  0%   { color: var(--fg-2); opacity: 0.6; }
  10%  { color: var(--user-accent); opacity: 1; }
  65%  { color: var(--user-accent); opacity: 1; }
  100% { color: var(--fg-2); opacity: 0.6; }
}
.exported-filename.copied { animation: filename-copied 1.4s ease forwards; }
@keyframes copy-pill-pop {
  0%   { opacity: 0; transform: translateY(4px) scale(0.88); }
  14%  { opacity: 1; transform: translateY(0) scale(1); }
  68%  { opacity: 1; transform: translateY(0) scale(1); }
  100% { opacity: 0; transform: translateY(-5px) scale(0.95); }
}
.copy-pill {
  position: fixed;
  background: var(--user-accent);
  color: var(--bg);
  font-family: system-ui, sans-serif;
  font-size: 0.65rem;
  font-weight: 600;
  letter-spacing: 0.04em;
  padding: 3px 8px;
  border-radius: 4px;
  white-space: nowrap;
  pointer-events: none;
  z-index: 9999;
  animation: copy-pill-pop 1.4s ease forwards;
}
.obsession-footer-version {
  display: block;
  margin-top: 6px;
  opacity: 0.5;
}
.exported-github-link {
  display: inline-flex;
  align-items: center;
  height: 28px;
  padding: 0 7px;
  color: var(--fg-3);
  text-decoration: none;
}
.exported-github-link:hover { color: var(--fg-2); }
#help-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 28px;
  padding: 0 10px;
  border-radius: 3px;
  border: 1px solid var(--border-2);
  background: transparent;
  color: var(--fg-2);
  cursor: pointer;
  font: inherit;
  font-size: 12px;
}
#help-btn:hover { color: var(--fg); }
#help-overlay { display: none; }
#help-overlay.visible { display: flex; }
@media (max-width: 540px) {
  #theme-toggle .btn-label, #theme-toggle .btn-arrow { display: none; }
  #theme-toggle, #help-btn { width: 28px; min-width: 28px; padding: 0; justify-content: center; }
}
`

export function buildStaticHtml(events, themeKey, title, { minify = false, filename = '' } = {}) {
  // Structural CSS first, then theme vars — equal specificity means last wins.
  const css = minify
    ? minifyCSS(rawCSS + '\n' + themeToCSS(themeKey) + '\n' + TOPBAR_CSS)
    : rawCSS + '\n\n' + themeToCSS(themeKey) + '\n' + TOPBAR_CSS

  const filenameHtml = filename
    ? `<span class="exported-filename">${escapeHtml(filename)}</span>`
    : ''
  const githubLink =
    `<a href="${REPO_URL}" target="_blank" rel="noopener noreferrer" ` +
    `class="exported-github-link" title="View source on GitHub" aria-label="GitHub repository">` +
    GITHUB_SVG + `</a>`

  const html =
    `<!DOCTYPE html>\n` +
    `<html lang="en">\n` +
    `<head>\n` +
    `  <meta charset="UTF-8">\n` +
    `  <meta name="viewport" content="width=device-width,initial-scale=1">\n` +
    `  <title>${escapeHtml(title)}</title>\n` +
    `  <style>\n${css}\n  </style>\n` +
    `</head>\n` +
    `<body>\n` +
    `<div class="exported-topbar">\n` +
    `  <div class="exported-brand-col">\n` +
    `    <span class="brand">claude <span>session</span></span>\n` +
    (filenameHtml ? `    ${filenameHtml}\n` : '') +
    `  </div>\n` +
    `  <span style="flex:1"></span>\n` +
    `  ${githubLink}\n` +
    `</div>\n` +
    `<div class="session-wrap">\n` +
    `  <div class="session">\n` +
    renderSession(events, pkg.version) + '\n' +
    `  </div>\n` +
    `</div>\n` +
    `</body>\n` +
    `</html>\n`

  return minify ? minifyHtml(html) : html
}

// ---------------------------------------------------------------------------
// Dynamic export — all themes switchable via a ~500-byte vanilla script.
// Session HTML is string-rendered (same path as static). Theme switching is a
// single data-theme attribute swap; it doesn't need a framework. Using the
// SolidJS bundle here instead would just produce the full-featured export.
// ---------------------------------------------------------------------------

// Strips line comments and collapses whitespace in the theme-switcher snippet.
// Not a general-purpose JS minifier — assumes no regex literals or template
// strings, which the switcher script doesn't use.
function minifyJs(js) {
  return js
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/^ /gm, '')
    .replace(/\n{2,}/g, '\n')
    .trim()
}

// Generates the self-contained theme-switcher script embedded in dynamic exports.
// Written with var and function declarations (no const/let/arrow functions) for
// maximum browser compatibility — the script runs before any polyfills load.
function buildSwitcherJs(themeKeys, minify) {
  const keys = JSON.stringify(themeKeys)
  const js = `
(function () {
  'use strict'

  var root      = document.documentElement
  var themeKeys = ${keys}
  var toggle    = document.getElementById('theme-toggle')
  var menu      = document.getElementById('theme-menu')
  var overlay   = document.getElementById('help-overlay')
  var filenameEl = document.getElementById('exported-filename')
  if (filenameEl) {
    var filenameText = filenameEl.textContent
    var filenameCopyTimer = null
    filenameEl.addEventListener('click', function () {
      navigator.clipboard.writeText(filenameText).catch(function () {})
      var rect = filenameEl.getBoundingClientRect()
      var pill = document.createElement('span')
      pill.className = 'copy-pill'
      pill.textContent = '✓ Copied'
      pill.style.top = rect.bottom + 7 + 'px'
      pill.style.left = rect.left + 'px'
      document.body.appendChild(pill)
      pill.addEventListener('animationend', function () { pill.remove() }, { once: true })
      filenameEl.classList.remove('copied')
      void filenameEl.offsetWidth
      filenameEl.classList.add('copied')
      clearTimeout(filenameCopyTimer)
      filenameCopyTimer = setTimeout(function () { filenameEl.classList.remove('copied') }, 1400)
    })
  }

  function setTheme(key) {
    root.dataset.theme = key
    var active = null
    document.querySelectorAll('.theme-btn').forEach(function (btn) {
      var isActive = btn.dataset.theme === key
      btn.classList.toggle('active', isActive)
      if (isActive) active = btn
    })
    ;(toggle.querySelector('.btn-label') || toggle).textContent = active ? active.textContent : key
    try { localStorage.setItem('cc-theme', key) } catch (_) {}
  }
  window.setTheme = setTheme

  // Honor the theme baked in at export time — do not restore from localStorage,
  // which could belong to a different session or a different exported file.
  setTheme(root.dataset.theme)

  function openThemeMenu()  { menu.style.display = 'block' }
  function closeThemeMenu() { menu.style.display = 'none' }
  function openHelp()  { overlay.classList.add('visible') }
  function closeHelp() { overlay.classList.remove('visible') }
  window.closeHelp  = closeHelp
  window.toggleHelp = function () {
    overlay.classList.contains('visible') ? closeHelp() : openHelp()
  }

  toggle.addEventListener('click', function (e) {
    menu.style.display === 'block' ? closeThemeMenu() : openThemeMenu()
    e.stopPropagation()
  })
  overlay.addEventListener('click', function (e) {
    if (e.target === overlay) closeHelp()
  })
  document.addEventListener('click', function () {
    closeThemeMenu()
  })

  document.addEventListener('keydown', function (e) {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) return
    if (e.ctrlKey || e.metaKey || e.altKey) return
    var helpOpen  = overlay.classList.contains('visible')
    var themeOpen = menu.style.display === 'block'
    switch (e.key) {
      case '?':
        e.preventDefault()
        helpOpen ? closeHelp() : openHelp()
        break
      case 'Escape':
      case 'q':
        if (helpOpen)                             { e.preventDefault(); closeHelp() }
        else if (e.key === 'Escape' && themeOpen) { e.preventDefault(); closeThemeMenu() }
        break
      case 'Enter':
        if (helpOpen)       { e.preventDefault(); closeHelp() }
        else if (themeOpen) { e.preventDefault(); closeThemeMenu() }
        break
      case 'ArrowUp':
      case 'ArrowDown': {
        if (themeOpen) {
          e.preventDefault()
          var delta = e.key === 'ArrowUp' ? -1 : 1
          var idx = themeKeys.indexOf(root.dataset.theme)
          setTheme(themeKeys[(idx + delta + themeKeys.length) % themeKeys.length])
        }
        break
      }
      case 't':
        e.preventDefault()
        themeOpen ? closeThemeMenu() : openThemeMenu()
        break
      case '[': {
        e.preventDefault()
        var idx = themeKeys.indexOf(root.dataset.theme)
        setTheme(themeKeys[(idx - 1 + themeKeys.length) % themeKeys.length])
        break
      }
      case ']': {
        e.preventDefault()
        var idx = themeKeys.indexOf(root.dataset.theme)
        setTheme(themeKeys[(idx + 1) % themeKeys.length])
        break
      }
    }
  })
}())
`
  return minify ? minifyJs(js) : js
}

// Single source of truth for the dynamic-export keyboard shortcuts overlay.
// The minified export path runs the full document through minifyHtml(), which
// collapses this just like any other HTML — no separate compact copy needed.
const DYNAMIC_HELP_OVERLAY =
`<div class="kbd-overlay" id="help-overlay">
  <div class="kbd-modal" onclick="event.stopPropagation()">
    <div class="kbd-modal-header">
      <span class="kbd-modal-title">Keyboard shortcuts</span>
      <button class="kbd-close" onclick="closeHelp()">✕</button>
    </div>
    <div class="kbd-section">
      <div class="kbd-section-title">Themes</div>
      <div class="kbd-row"><span class="kbd-desc">Open / close theme picker</span><span class="kbd-keys"><kbd>t</kbd></span></div>
      <div class="kbd-row"><span class="kbd-desc">Navigate themes (in picker)</span><span class="kbd-keys"><kbd>↑</kbd><kbd>↓</kbd></span></div>
      <div class="kbd-row"><span class="kbd-desc">Previous theme</span><span class="kbd-keys"><kbd>[</kbd></span></div>
      <div class="kbd-row"><span class="kbd-desc">Next theme</span><span class="kbd-keys"><kbd>]</kbd></span></div>
    </div>
    <div class="kbd-section">
      <div class="kbd-section-title">Help</div>
      <div class="kbd-row"><span class="kbd-desc">Show / hide shortcuts</span><span class="kbd-keys"><kbd>?</kbd></span></div>
      <div class="kbd-row"><span class="kbd-desc">Close</span><span class="kbd-keys"><kbd>Esc</kbd><kbd>q</kbd><kbd>Enter</kbd></span></div>
    </div>
    <div class="kbd-footer"><span>press <kbd>?</kbd> to dismiss</span><span>v${pkg.version}</span></div>
  </div>
</div>`

export function buildDynamicHtml(events, themeKey, title, { minify = false, filename = '' } = {}) {
  const css = minify
    ? minifyCSS(rawCSS + '\n' + allThemesToCSS() + '\n' + TOPBAR_CSS)
    : rawCSS + '\n\n' + allThemesToCSS() + '\n' + TOPBAR_CSS

  // data-theme on each button lets setTheme() find the active one cleanly.
  const themeButtons = Object.entries(THEMES).map(([key, t]) =>
    `<button class="theme-btn${key === themeKey ? ' active' : ''}" data-theme="${key}" onclick="setTheme('${key}')">${escapeHtml(t.label)}</button>`
  ).join('\n      ')

  const js = buildSwitcherJs(THEME_KEYS, minify)

  const filenameHtml = filename
    ? `<span class="exported-filename" id="exported-filename" title="${escapeHtml(filename)}">${escapeHtml(filename)}</span>`
    : ''
  const githubLink =
    `<a href="${REPO_URL}" target="_blank" rel="noopener noreferrer" ` +
    `class="exported-github-link" title="View source on GitHub" aria-label="GitHub repository">` +
    GITHUB_SVG + `</a>`

  const html =
    `<!DOCTYPE html>\n` +
    `<html lang="en" data-theme="${themeKey}">\n` +
    `<head>\n` +
    `  <meta charset="UTF-8">\n` +
    `  <meta name="viewport" content="width=device-width,initial-scale=1">\n` +
    `  <title>${escapeHtml(title)}</title>\n` +
    `  <style>\n${css}\n  </style>\n` +
    `</head>\n` +
    `<body>\n` +
    `<div class="exported-topbar">\n` +
    `  <div class="exported-brand-col">\n` +
    `    <span class="brand">claude <span>session</span></span>\n` +
    (filenameHtml ? `    ${filenameHtml}\n` : '') +
    `  </div>\n` +
    `  <div class="theme-toggle-wrap">\n` +
    `    <button id="theme-toggle"><span>◑</span><span class="btn-label">theme</span><span class="btn-arrow">▾</span></button>\n` +
    `    <div id="theme-menu">\n      ${themeButtons}\n    </div>\n` +
    `  </div>\n` +
    `  <button id="help-btn" onclick="toggleHelp()">?</button>\n` +
    `  ${githubLink}\n` +
    `</div>\n` +
    `<div class="session-wrap">\n` +
    `  <div class="session">\n` +
    renderSession(events) + '\n' +
    `  </div>\n` +
    `</div>\n` +
    DYNAMIC_HELP_OVERLAY + '\n' +
    `<script>${js}</script>\n` +
    `</body>\n` +
    `</html>\n`

  return minify ? minifyHtml(html) : html
}

// ---------------------------------------------------------------------------
// Full-featured export — inlines the production SolidJS bundle + session JSON.
// The bundle re-renders the session using the same Block.jsx components as the
// live SPA. Self-replicating: an already-exported file carries its own bundle,
// so re-exporting from it doesn't require a rebuild.
//
// Requires the production build. This is not a fixable limitation: the Vite
// dev server serves un-bundled ESM modules individually — there is no single
// file to inline. A dev plugin could trigger vite.build() on demand, but that
// just runs a full build synchronously on the first export request, adding
// seconds of latency and config complexity with no real benefit over the
// straightforward `bun run build && bun run preview` flow.
// ---------------------------------------------------------------------------

const DEV_ERROR =
  'Full-featured export requires the production build.\n' +
  'Run:  bun run build && bun run preview\n' +
  'Then open http://localhost:4173 and export from there.'

// JSON.stringify does not escape </ sequences. In a <script> block, </script>
// terminates the script even inside a string literal. Apply the same fix used
// in vite.config.js for the bundle: replace </ with <\/.
function safeJson(val) {
  return JSON.stringify(val).replace(/<\/(script)/gi, '<\\/$1')
}

export async function buildFullFeatured(events, rawText, themeKey, title, { minify = false, filename = '' } = {}) {
  // Source for the JS bundle, in priority order:
  //   1. #__bundle__ script tag — present in any previously exported full-featured
  //      HTML; reading textContent avoids storing the bundle a second time.
  //   2. ./assets/index.js — the production build, served by `bun run preview`
  //      or a real web server. Not present in the Vite dev server.
  let js = document.getElementById('__bundle__')?.textContent.trim() || null

  if (!js) {
    // The Vite dev server returns 200 + the SPA HTML for any unknown path
    // (its SPA fallback). Guard against this by checking Content-Type and
    // whether the content itself starts with '<'.
    try {
      const resp = await fetch('./assets/index.js')
      if (!resp.ok) throw new Error()
      const ct = resp.headers.get('content-type') || ''
      if (ct.includes('text/html')) throw new Error()
      js = await resp.text()
      if (js.trimStart().startsWith('<')) throw new Error()
      js = js.replace(/<\/(script)/gi, '<\\/$1')
    } catch {
      throw new Error(DEV_ERROR)
    }
  }

  // The JS app calls applyTheme() at runtime to write CSS vars onto :root,
  // so allThemesToCSS() is not needed — the app handles all theme switching.
  const css = minify ? minifyCSS(rawCSS) : rawCSS

  const preload =
    `window.__PRELOADED_SESSION__  = ${safeJson(rawText)};\n` +
    `window.__PRELOADED_THEME__    = ${JSON.stringify(themeKey)};\n` +
    `window.__PRELOADED_FILENAME__ = ${safeJson(filename)};`

  const html =
    `<!DOCTYPE html>\n` +
    `<html lang="en" data-theme="${themeKey}">\n` +
    `<head>\n` +
    `  <meta charset="UTF-8">\n` +
    `  <meta name="viewport" content="width=device-width,initial-scale=1">\n` +
    `  <title>${escapeHtml(title)}</title>\n` +
    `  <style>\n${css}\n  </style>\n` +
    `</head>\n` +
    `<body>\n` +
    `<div id="root"></div>\n` +
    `<script>\n${preload}\n</script>\n` +
    `<script type="module" id="__bundle__">\n${js}\n</script>\n` +
    `</body>\n` +
    `</html>\n`

  return minify ? minifyHtml(html) : html
}

// ---------------------------------------------------------------------------
// Download helper
// ---------------------------------------------------------------------------

export function download(filename, content, mime = 'text/html') {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
