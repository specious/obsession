import { createSignal, onMount, onCleanup, Show, For } from 'solid-js'
import { parse } from '../parse.js'
import { THEMES, THEME_KEYS, DEFAULT_THEME, applyTheme } from '../themes.js'
import { buildStaticHtml, buildDynamicHtml, buildFullFeatured, download, GITHUB_ICON_PATH } from '../render.js'
import { SessionView } from './SessionView.jsx'
import pkg from '../../package.json'

const REPO_URL = pkg.repository

// ---------------------------------------------------------------------------
// Export menu
// ---------------------------------------------------------------------------

const EXPORT_OPTIONS = [
  {
    id: 'full-featured',
    label: 'Full-featured',
    desc: 'Complete app — load sessions, switch themes, re-export',
  },
  {
    id: 'dynamic',
    label: 'Dynamic HTML',
    desc: 'All themes switchable, session baked in',
  },
  {
    id: 'static',
    label: 'Static HTML',
    desc: 'Current theme only, zero JavaScript',
  },
]

function ExportMenu(props) {
  return (
    <div class="export-menu">
      <div class={`export-toggle${props.cursor === 0 ? ' focused' : ''}`} onClick={props.onToggleMinify}>
        <span class="export-toggle-label">Compact file</span>
        <span class={`export-toggle-pip${props.minify ? ' on' : ''}`} />
      </div>
      <div class="menu-divider" />
      <For each={EXPORT_OPTIONS}>
        {(opt, i) => (
          <div class={`export-option${props.cursor === i() + 1 ? ' focused' : ''}`} onClick={() => props.onExport(opt.id)}>
            <span class="export-option-label">{opt.label}</span>
            <span class="export-option-desc">{opt.desc}</span>
          </div>
        )}
      </For>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Theme picker
// ---------------------------------------------------------------------------

function ThemePicker(props) {
  return (
    <div class="theme-menu">
      <For each={THEME_KEYS}>
        {key => (
          <div
            class={`theme-option${props.current === key ? ' active' : ''}`}
            onClick={() => props.onSelect(key)}
          >
            <span
              class="theme-swatch"
              style={{
                background: THEMES[key].vars['--bg'] || '#444',
                border: `1px solid ${key === 'claude-light' ? '#ccc' : 'rgba(255,255,255,.15)'}`,
              }}
            />
            <span class="theme-label">{THEMES[key].label}</span>
          </div>
        )}
      </For>
    </div>
  )
}

// ---------------------------------------------------------------------------
// GitHub link
// ---------------------------------------------------------------------------

// Inline SVG — avoids an external fetch that would fail on file:// origins.
// Path is the standard GitHub Invertocat mark on a 16×16 grid.
function GitHubIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d={GITHUB_ICON_PATH} />
    </svg>
  )
}

// ---------------------------------------------------------------------------
// Drop zone
// ---------------------------------------------------------------------------

function DropZone(props) {
  const [dragging, setDragging] = createSignal(false)

  const openPicker = () => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.md,.txt,text/plain,text/markdown'
    input.onchange = e => e.target.files?.[0] && props.onFile(e.target.files[0])
    input.click()
  }

  return (
    <div
      class={`dropzone${dragging() ? ' dragging' : ''}`}
      onDragOver={e => { e.preventDefault(); setDragging(true) }}
      onDragLeave={() => setDragging(false)}
      onDrop={e => { e.preventDefault(); setDragging(false); const f = e.dataTransfer?.files?.[0]; if (f) props.onFile(f) }}
      onClick={openPicker}
    >
      <div class="dropzone-icon">⌘</div>
      <div class="dropzone-label">Drop a Claude Code session export here</div>
      <div class="dropzone-sub">or click to pick a file · exported with /export in Claude Code</div>
      <div class="dropzone-pick" onClick={e => { e.stopPropagation(); openPicker() }} role="button">
        Choose file
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Keyboard shortcuts help overlay
// ---------------------------------------------------------------------------

const SHORTCUT_SECTIONS = [
  {
    title: 'Navigation',
    rows: [
      { keys: ['h'],          desc: 'Go home' },
      { keys: ['Esc'],        desc: 'Close menus' },
    ],
  },
  {
    title: 'Export menu',
    rows: [
      { keys: ['e'],          desc: 'Open / close export menu' },
      { keys: ['↑', '↓'],     desc: 'Select option' },
      { keys: ['Enter'],      desc: 'Confirm selection' },
      { keys: ['c'],          desc: 'Toggle compact file' },
    ],
  },
  {
    title: 'Themes',
    rows: [
      { keys: ['t'],          desc: 'Open / close theme picker' },
      { keys: ['['],          desc: 'Previous theme' },
      { keys: [']'],          desc: 'Next theme' },
      { keys: ['↑', '↓'],     desc: 'Navigate themes (in picker)' },
    ],
  },
  {
    title: 'File',
    rows: [
      { keys: ['o'],          desc: 'Open file' },
    ],
  },
]

function KeyboardHelp(props) {
  return (
    <div class="kbd-overlay" onClick={props.onClose}>
      <div class="kbd-modal" onClick={e => e.stopPropagation()}>
        <div class="kbd-modal-header">
          <span class="kbd-modal-title">Keyboard shortcuts</span>
          <button class="kbd-close" onClick={props.onClose}>✕</button>
        </div>
        <For each={SHORTCUT_SECTIONS}>
          {section => (
            <div class="kbd-section">
              <div class="kbd-section-title">{section.title}</div>
              <For each={section.rows}>
                {row => (
                  <div class="kbd-row">
                    <span class="kbd-desc">{row.desc}</span>
                    <span class="kbd-keys">
                      <For each={row.keys}>{key => <kbd>{key}</kbd>}</For>
                    </span>
                  </div>
                )}
              </For>
            </div>
          )}
        </For>
        <div class="kbd-footer">
          <span>press <kbd>?</kbd> to dismiss</span>
          <span>v{pkg.version}</span>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main App
// ---------------------------------------------------------------------------

export function App() {
  const [events, setEvents] = createSignal(null)
  const [rawText, setRawText] = createSignal('')
  const [theme, setTheme] = createSignal(DEFAULT_THEME)
  const [showThemes, setShowThemes] = createSignal(false)
  const [showExport, setShowExport] = createSignal(false)
  const [exportCursor, setExportCursor] = createSignal(-1)
  const [exporting, setExporting] = createSignal(false)
  const [exportError, setExportError] = createSignal('')
  const [parseError, setParseError] = createSignal('')
  const [filename, setFilename] = createSignal('')
  let filenameRef, filenameCopyTimer
  onCleanup(() => clearTimeout(filenameCopyTimer))
  function copyFilename() {
    navigator.clipboard.writeText(filename()).catch(() => {})
    if (!filenameRef) return
    const rect = filenameRef.getBoundingClientRect()
    const pill = document.createElement('span')
    pill.className = 'copy-pill'
    pill.textContent = '✓ Copied'
    pill.style.top = `${rect.bottom + 7}px`
    pill.style.left = `${rect.left}px`
    document.body.appendChild(pill)
    pill.addEventListener('animationend', () => pill.remove(), { once: true })
    filenameRef.classList.remove('copied')
    void filenameRef.offsetWidth
    filenameRef.classList.add('copied')
    clearTimeout(filenameCopyTimer)
    filenameCopyTimer = setTimeout(() => filenameRef?.classList.remove('copied'), 1400)
  }
  const [dragOver, setDragOver] = createSignal(false)
  const [showHelp, setShowHelp] = createSignal(false)
  // Counter rather than boolean: dragenter/dragleave fire for every child element
  // individually, so hovering a child emits a dragleave for the parent followed
  // immediately by a dragenter for the child. A simple boolean would flip to false
  // at that dragleave. The counter stays > 0 as long as any descendant is active.
  let dragCounter = 0
  let fileInputRef
  // IIFE computes the initial value synchronously before first render. The
  // try/catch is necessary because localStorage.getItem() throws a SecurityError
  // in some private-browsing configurations (Safari, Firefox strict mode).
  const [minify, setMinify] = createSignal(
    (() => { try { return localStorage.getItem('cc-minify') === 'true' } catch { return false } })()
  )

  onMount(() => {
    try {
      const saved = localStorage.getItem('cc-theme')
      if (saved && THEMES[saved]) selectTheme(saved)
      else applyTheme(DEFAULT_THEME)
    } catch {
      applyTheme(DEFAULT_THEME)
    }

    // On HMR reload the component remounts but history.state still holds the
    // previous session — restore it before overwriting state with the blank seed.
    const existingState = history.state
    if (existingState?.type === 'session') {
      loadText(existingState.rawText, existingState.filename, { pushHistory: false })
    } else {
      // Seed the initial history entry with a typed state object. Without this,
      // navigating back to the landing page produces a popstate with e.state === null,
      // which our handler can't distinguish from an unrelated navigation.
      history.replaceState({ type: 'blank' }, '')

      // Pre-load session if baked in by a full-featured export
      if (window.__PRELOADED_SESSION__) {
        const name = window.__PRELOADED_FILENAME__ || 'preloaded-session.md'
        loadText(window.__PRELOADED_SESSION__, name, { pushHistory: false })
        history.replaceState({ type: 'session', rawText: window.__PRELOADED_SESSION__, filename: name }, '')
      }
    }
    if (window.__PRELOADED_THEME__ && THEMES[window.__PRELOADED_THEME__]) {
      selectTheme(window.__PRELOADED_THEME__)
    }

    const onPopState = e => {
      const state = e.state
      if (!state || state.type === 'blank') {
        closeSession({ pushHistory: false })
      } else if (state.type === 'session') {
        loadText(state.rawText, state.filename, { pushHistory: false })
      }
    }
    window.addEventListener('popstate', onPopState)

    // Dismiss menus on outside click.
    // Solid.js delegates onClick to the document, so stopPropagation() inside
    // a handler can't prevent this listener from also firing on the same click.
    // Check closest() to detect whether the click landed inside a menu instead.
    const onDocClick = e => {
      if (!e.target.closest('.theme-picker, .export-wrap')) {
        setShowThemes(false)
        setShowExport(false)
        setExportCursor(-1)
      }
    }
    document.addEventListener('click', onDocClick)

    const onKeyDown = e => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) return
      if (e.ctrlKey || e.metaKey || e.altKey) return
      switch (e.key) {
        case '?':
          e.preventDefault()
          setShowHelp(v => !v)
          setShowThemes(false)
          setShowExport(false)
          setExportCursor(-1)
          break
        case 'Escape':
        case 'q':
          if (showHelp()) { e.preventDefault(); setShowHelp(false); break }
          if (e.key === 'Escape') {
            if (showThemes()) { e.preventDefault(); setShowThemes(false); break }
            if (showExport()) { e.preventDefault(); setShowExport(false); setExportCursor(-1); break }
          }
          break
        case 'Enter':
          if (showHelp()) { e.preventDefault(); setShowHelp(false); break }
          if (showThemes()) { e.preventDefault(); setShowThemes(false); break }
          if (showExport()) {
            e.preventDefault()
            const cur = exportCursor()
            if (cur === 0) toggleMinify()
            else if (cur >= 1) handleExport(EXPORT_OPTIONS[cur - 1].id)
            break
          }
          break
        case 'ArrowUp':
        case 'ArrowDown': {
          if (showExport()) {
            e.preventDefault()
            const total = 1 + EXPORT_OPTIONS.length
            const delta = e.key === 'ArrowUp' ? -1 : 1
            setExportCursor(v => v < 0 ? (delta > 0 ? 0 : total - 1) : (v + delta + total) % total)
          } else if (showThemes()) {
            e.preventDefault()
            const delta = e.key === 'ArrowUp' ? -1 : 1
            const idx = THEME_KEYS.indexOf(theme())
            selectTheme(THEME_KEYS[(idx + delta + THEME_KEYS.length) % THEME_KEYS.length])
          }
          break
        }
        case 'c':
          if (showExport()) { e.preventDefault(); toggleMinify() }
          break
        case 'h':
          if (events()) { closeSession(); setShowHelp(false) }
          break
        case 'o':
          setShowHelp(false)
          openPicker()
          break
        case 'e':
          if (events()) {
            const opening = !showExport()
            setShowExport(opening)
            setShowThemes(false)
            setExportCursor(opening ? 0 : -1)
          }
          break
        case 't':
          setShowThemes(v => !v)
          setShowExport(false)
          setExportCursor(-1)
          break
        case '[': {
          const idx = THEME_KEYS.indexOf(theme())
          selectTheme(THEME_KEYS[(idx - 1 + THEME_KEYS.length) % THEME_KEYS.length])
          break
        }
        case ']': {
          const idx = THEME_KEYS.indexOf(theme())
          selectTheme(THEME_KEYS[(idx + 1) % THEME_KEYS.length])
          break
        }
      }
    }
    document.addEventListener('keydown', onKeyDown)
    onCleanup(() => {
      window.removeEventListener('popstate', onPopState)
      document.removeEventListener('click', onDocClick)
      document.removeEventListener('keydown', onKeyDown)
    })
  })

  function selectTheme(key) {
    setTheme(key)
    applyTheme(key)
    try { localStorage.setItem('cc-theme', key) } catch {}
  }

  function toggleMinify() {
    setMinify(v => {
      try { localStorage.setItem('cc-minify', !v) } catch {}
      return !v
    })
  }

  function loadText(text, name = '', { pushHistory = true } = {}) {
    setParseError('')
    const parsed = parse(text)
    if (parsed.length === 0) {
      setParseError(name || 'this file')
      return
    }
    setRawText(text)
    setFilename(name)
    setEvents(parsed)
    window.scrollTo(0, 0)
    const base = name.replace(/\.[^.]+$/, '')
    document.title = `Claude session: ${base}`
    if (pushHistory) {
      history.pushState({ type: 'session', rawText: text, filename: name }, '')
    }
  }

  function openPicker() {
    fileInputRef?.click()
  }

  async function handleFile(file) {
    const text = await file.text()
    loadText(text, file.name)
  }

  async function handleExport(type) {
    setShowExport(false)
    setExportCursor(-1)
    setExportError('')
    if (!events()) return
    setExporting(true)

    const base = filename().replace(/\.[^.]+$/, '')
    const title = `Claude session: ${base}`
    const opts = { minify: minify() }

    try {
      if (type === 'static') {
        download(`${base}-static.html`, buildStaticHtml(events(), theme(), title, { ...opts, filename: filename() }))
      } else if (type === 'dynamic') {
        download(`${base}-dynamic.html`, buildDynamicHtml(events(), theme(), title, { ...opts, filename: filename() }))
      } else {
        const html = await buildFullFeatured(events(), rawText(), theme(), title, { ...opts, filename: filename() })
        download(`${base}-full-featured.html`, html)
      }
    } catch (err) {
      setExportError(err.message)
      window.scrollTo(0, 0)
    } finally {
      setExporting(false)
    }
  }

  function closeSession({ pushHistory = true } = {}) {
    setEvents(null)
    setRawText('')
    setFilename('')
    setExportError('')
    setParseError('')
    document.title = 'Claude Session Viewer'
    if (pushHistory) {
      history.pushState({ type: 'blank' }, '')
    }
  }

  return (
    <>
      <div class="topbar">
        <div class="topbar-brand">
          <div
            class={`topbar-brand-name${events() ? ' topbar-brand-home' : ''}`}
            onClick={() => events() && closeSession()}
          >
            claude <span>session</span>
          </div>
          <Show when={events()}>
            <div
              ref={filenameRef}
              class="topbar-filename"
              title={filename()}
              onClick={copyFilename}
            >{filename()}</div>
          </Show>
        </div>
        <div class="topbar-spacer" />
        <div class="theme-picker" style="position:relative">
          <button
            class="topbar-btn"
            onClick={() => { setShowThemes(v => !v); setShowExport(false) }}
          >
            <span>◑</span>
            <span class="btn-label">{THEMES[theme()].label}</span><span class="btn-arrow">▾</span>
          </button>
          <Show when={showThemes()}>
            <ThemePicker current={theme()} onSelect={key => { selectTheme(key); setShowThemes(false) }} />
          </Show>
        </div>

        <Show when={events()}>
          <button class="topbar-btn" onClick={openPicker}>
            <span>↑</span>
            <span class="btn-label">Open</span>
          </button>

          <div class="export-wrap" style="position:relative">
            <button
              class={`topbar-btn primary${exporting() ? ' disabled' : ''}`}
              onClick={() => { setShowExport(v => !v); setShowThemes(false) }}
              disabled={exporting()}
            >
              <span>↓</span>
              <span class="btn-label">{exporting() ? 'Exporting…' : 'Export'}</span>
            </button>
            <Show when={showExport()}>
              <ExportMenu
                minify={minify()}
                cursor={exportCursor()}
                onToggleMinify={toggleMinify}
                onExport={handleExport}
              />
            </Show>
          </div>
        </Show>

        <button
          class="topbar-btn"
          onClick={() => setShowHelp(v => !v)}
          title="Keyboard shortcuts"
        >
          <span>?</span>
          <span class="btn-label">Help</span>
        </button>

        <a
          href={REPO_URL}
          target="_blank"
          rel="noopener noreferrer"
          class="topbar-btn topbar-icon-link"
          title="View source on GitHub"
          aria-label="GitHub repository"
        >
          <GitHubIcon />
        </a>
      </div>

      <Show when={exportError()}>
        <div class="export-error">
          <strong>Export failed</strong>
          <pre>{exportError()}</pre>
          <button onClick={() => setExportError('')}>✕</button>
        </div>
      </Show>

      <Show when={events()} fallback={
        <Show when={parseError()} fallback={<DropZone onFile={handleFile} />}>
          <div class="parse-error-zone" onClick={() => setParseError('')}>
            <div class="parse-error-icon">⚠</div>
            <div class="parse-error-title">Couldn't read this file</div>
            <div class="parse-error-file">{parseError()}</div>
            <div class="parse-error-hint">
              This doesn't look like a Claude Code session export.
              Use <code>/export</code> inside Claude Code to generate a compatible file.
            </div>
            <div class="parse-error-back">Click anywhere to try another file</div>
          </div>
        </Show>
      }>
        <div
          class="session-drop-target"
          onDragEnter={e => { e.preventDefault(); dragCounter++; setDragOver(true) }}
          onDragOver={e => e.preventDefault()}
          onDragLeave={() => { dragCounter--; if (dragCounter === 0) setDragOver(false) }}
          onDrop={e => {
            e.preventDefault()
            dragCounter = 0
            setDragOver(false)
            const f = e.dataTransfer?.files?.[0]
            if (f) handleFile(f)
          }}
        >
          <Show when={dragOver()}>
            <div class="session-drop-overlay">
              <div class="session-drop-label">Drop to load session</div>
            </div>
          </Show>
          <SessionView events={events()} />
        </div>
      </Show>

      <Show when={showHelp()}>
        <KeyboardHelp onClose={() => setShowHelp(false)} />
      </Show>

      <input
        ref={fileInputRef}
        type="file"
        accept=".md,.txt,text/plain,text/markdown"
        style="display:none"
        onChange={e => { const f = e.target.files?.[0]; if (f) { handleFile(f); e.target.value = '' } }}
      />
    </>
  )
}
