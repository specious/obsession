// Parse the plain-text output of Claude Code's /export command into structured events.
//
// Format overview
//
//   <header>  everything before the first session-event sigil (❯ ● ✻); the
//             header's internal layout is intentionally ignored — see the
//             cross-version compatibility note below
//
//   ❯ user message line 1
//     continuation (2-space indent; terminal pads ALL user lines to 80 chars)
//   ⎿  @file reference (U+23BF then space+NBSP)
//
//   ● assistant text or tool call header
//     continuation body (2-space indent, NOT padded — raw content length only)
//   ⎿  tool result label
//      1  context line }  diff block (4+ space indent, with line numbers)
//      2 +added line   }
//      3 -removed line }
//      … +N lines (ctrl+o to expand)   ← UI expand hint, not diff content
//
//   ✻ Cogitated for 2m 33s  ← thinking-time indicator
//
// Cross-version compatibility
//
// The header banner has already changed once (v2.1.123 decorative ╭─╮ box →
// v2.1.128 compact inline banner) and will likely change again. The session
// body has remained stable because its sigils (❯ ● ✻) are load-bearing: tools
// and users depend on them. The compatibility strategy has two layers:
//
//   1. Sigil anchoring. The header is defined structurally as "everything before
//      the first ❯/●/✻ line", not by any banner-specific character or layout.
//      The sigils are semantic markers in the export language, not UI chrome,
//      so they're a far more durable boundary than any particular box-drawing
//      choice.
//
//   2. Pattern scanning. parseHeaderMeta() matches known substrings (version
//      string, model·plan chain, ~/path) anywhere in the header text, without
//      assuming any column layout or line count. If a field moves, disappears,
//      or gains new ·-separated parts, the patterns either find it or produce a
//      missing field — which the renderer silently skips rather than crashing.
//
// Three core challenges (in the session body)
//
// 1. Hard-wrapping. The terminal wraps all text at 80 columns. User-turn
//    lines are right-padded to exactly 80 chars; assistant lines are not.
//    unwrapProse() re-joins lines that were split by the wrap algorithm.
//
// 2. Diff content. Tool diffs are themselves wrapped inside the export.
//    parseDiffLine() decodes each line, joinDiffWraps() re-joins continuations.
//
// 3. Intentional structure. Some line breaks are the author's intent, not
//    terminal artifacts — paragraph separators, list items, horizontal rules,
//    section labels ending with ':'. These must NOT be rejoined.

// ⎿ (U+23BF) followed by its two-char separator (space + NBSP)
const HOOK = '⎿  '

// Strip the ⎿ prefix from a string that starts with it (after any leading whitespace)
function stripHook(s) {
  const idx = s.indexOf(HOOK)
  return idx === -1 ? s : s.slice(idx + HOOK.length)
}

// ---------------------------------------------------------------------------
// Diff line parser
// ---------------------------------------------------------------------------
//
// After stripping the outer 2-space export indent, diff lines have a fixed
// column layout:
//
//   <8-char gutter>  <typechar>  <file content>
//
// The gutter holds the line number, right-aligned with spaces. The typechar
// is ' ' (context), '+' (added), or '-' (removed). Examples:
//
//   "      13 -// old content"   removed
//   "      13 +// new content"   added
//   "      13  // ctx content"   context (space typechar)
//   "      13"                   blank context line (no content follows)
//   "         -continuation"     no line number → wrapped continuation
//
// When the terminal wraps a diff line mid-content, the continuation line has
// no line number — only indentation and (usually) the same typechar. The
// exception: if the file content starts with '-' or '+', the context-space
// marker may be dropped in the export, making the continuation look like a
// removed/added line. joinDiffWraps() handles this mismatch.

function parseDiffLine(line) {
  // Normal line: <spaces><digits><space><typechar><content>
  let m = line.match(/^(\s+)(\d+)\s([-+ ])(.*)$/)
  if (m) {
    const [, , lineNum, typeChar, content] = m
    const type = typeChar === '+' ? 'added' : typeChar === '-' ? 'removed' : 'context'
    return { type, lineNum, content }
  }

  // Blank context line: digits only, no trailing content (the source line was empty)
  m = line.match(/^(\s+)(\d+)\s*$/)
  if (m) {
    return { type: 'context', lineNum: m[2], content: '' }
  }

  // Continuation line: no line number, starts with a typechar.
  // Note: the typechar may be a content character (e.g. '-' in a CSS border),
  // not a real diff marker. joinDiffWraps() detects and corrects this.
  m = line.match(/^(\s+)([-+])(.*)$/)
  if (m) {
    const [, , typeChar, content] = m
    return { type: typeChar === '+' ? 'added' : 'removed', lineNum: null, content }
  }

  // Catch-all: indented content with no recognisable structure.
  // Covers context-line continuations whose space typechar is absorbed into
  // the leading \s+ and is indistinguishable from plain indentation.
  return { type: 'wrap', lineNum: null, content: line.trim() }
}

function parseDiffBlock(lines) {
  return lines
    // "… +N lines (ctrl+o to expand)" lines are UI expand hints injected by
    // the terminal, not actual diff content — drop them before parsing.
    .filter(line => !/^\s*…/.test(line))
    // Lines with at least 4 spaces of indent are structured diff rows.
    // The raw fallback is a safety net; in the normal parse path all lines
    // in diffLines have already passed the same 4-space filter, so raw is
    // never produced (the tool-result label is captured as pendingResultText
    // before diff accumulation begins, not passed in here).
    .map(line =>
      /^\s{4}/.test(line) ? parseDiffLine(line) : { type: 'raw', lineNum: null, content: line }
    )
}

// ---------------------------------------------------------------------------
// Diff wrap joiner
// ---------------------------------------------------------------------------
//
// The terminal also wraps diff content lines at 80 columns. parseDiffLine()
// identifies continuation rows (lineNum === null); this function folds each
// one back onto the preceding line, restoring the full original file content.
//
// Type-mismatch case: a context line whose file content starts with '-' will
// have its continuation misclassified as `removed` (the '-' was parsed as a
// diff typechar instead of a content character). We detect this by comparing
// the continuation's type against the parent's type. When they differ, the
// consumed character is prepended back before joining.

function joinDiffWraps(lines) {
  const out = []
  for (const line of lines) {
    const prev = out[out.length - 1]

    // A line without a line number is always a continuation — either the
    // explicit `wrap` fallback, or an added/removed continuation with a
    // typechar marker. Joining is unconditional on the type match.
    const isContinuation = prev && (line.type === 'wrap' || line.lineNum === null)

    if (isContinuation) {
      // If the continuation's type disagrees with its parent, the diff-typechar
      // position was actually file content (e.g. '-' in a CSS dash border).
      // Restore the consumed character so no byte is silently dropped.
      const prefix = (line.type !== 'wrap' && line.type !== prev.type)
        ? (line.type === 'added' ? '+' : line.type === 'removed' ? '-' : '')
        : ''
      out[out.length - 1] = { ...prev, content: prev.content + prefix + line.content }
    } else if (!prev && line.lineNum === null) {
      // Orphaned continuation at the very top of a diff excerpt — the parent
      // line was scrolled out of the terminal display window. Show as context
      // rather than whatever type parseDiffLine guessed from the content.
      out.push({ ...line, type: 'context' })
    } else {
      out.push(line)
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Tool result builder
// ---------------------------------------------------------------------------

function makeToolResult(text, diffLines) {
  const parsed  = parseDiffBlock(diffLines)
  const hasDiff = parsed.some(l => l.type === 'added' || l.type === 'removed' || l.type === 'context')
  return {
    kind: 'tool-result',
    text,
    diff: hasDiff ? joinDiffWraps(parsed) : null,
    raw: diffLines,
  }
}

// ---------------------------------------------------------------------------
// Prose unwrapper
// ---------------------------------------------------------------------------
//
// The central question for every line: was this line break inserted by the
// terminal's wrap algorithm, or did the author intend it?
//
// Heuristic: if the preceding line is long (≥ WRAP_THRESHOLD chars), it
// probably hit the 80-column limit and was cut — join the next line onto it.
// If the preceding line is short, the break was intentional — leave it alone.
//
// Additional guards prevent false joins:
//
//   isNewUnit    — lines that always open a new semantic block regardless of
//                  the previous line's length. Covers:
//                    ● ❯ ⎿ ✻    session sigils
//                    > # *      blockquote / heading / bullet
//                    - <space>  markdown list item (bare '-' would catch -shm,
//                               --flags, and negative numbers)
//                    N. <space> ordered list
//                    ---        ASCII horizontal rule
//                    U+2500–257F  any box-drawing char (tables: │ ┌ ├ └ …)
//
//   tail.endsWith(':')  — a line that ends with a colon typically introduces
//                         a new section or label; the following content is a
//                         new unit even when the line is long enough to have
//                         been wrapped. (E.g. "Here's a summary of changes:")
//
// Lines accumulate in `out` with their original trailing whitespace intact;
// trimEnd() runs only once, at the very end of this function. So a user-turn
// line padded to 80 chars measures 80 in the tailRaw.length check below —
// always clearing any threshold ≤ 80, even when the visible text is short.
// Assistant lines are never padded, so the threshold must be low enough to
// catch genuinely short-wrapped prose — 55 is the shortest wrap point observed.
const WRAP_THRESHOLD = 55

// Comment lines (// or #) inside fences are prose — the terminal wraps them
// at word boundaries and the export can break them well before the column
// limit when the next word is long. Use a lower threshold for those joins.
const COMMENT_WRAP_THRESHOLD = 50

// fences: when true, also unwrap inside fenced code blocks.
// Used for user turns, where every wrap (including mid-identifier) is a
// terminal artifact — user-turn lines are padded to 80 cols.
function unwrapProse(text, { fences = false } = {}) {
  const lines = text.split('\n')
  const out   = []
  let fenceDepth = 0
  let lastOrigLen = 0  // pre-accumulation length of the last pushed line; zeroed after a fence join to prevent the next code line from cascading into a second join
  let pendingBlanks = 0  // buffered blank lines inside user-turn fences

  // The terminal inserts one extra blank line after every line in a user turn,
  // including inside fenced blocks. floor(N/2) recovers the original blank count:
  //   1 blank in export (terminal artifact, 0 original) → 0
  //   3 blanks in export (1 original + 2 artifacts)     → 1
  // When 0 blanks are emitted, lastOrigLen is preserved so wrap-joins still work.
  function flushPendingBlanks() {
    if (pendingBlanks === 0) return
    const toEmit = Math.floor(pendingBlanks / 2)
    for (let j = 0; j < toEmit; j++) out.push('')
    pendingBlanks = 0
    if (toEmit > 0) lastOrigLen = 0
  }

  for (const line of lines) {
    if (/^```/.test(line)) {
      // ```word → always a new fence opener (nested or top-level).
      // bare ``` → closes the innermost open fence, or opens one if not inside any.
      if (fenceDepth > 0 && fences) flushPendingBlanks()
      if (/^```\w/.test(line))   fenceDepth++
      else if (fenceDepth > 0)   fenceDepth--
      else                       fenceDepth++
      out.push(line); lastOrigLen = line.length; continue
    }

    // Blank lines: buffer inside fences when processing user turns (fences=true)
    // so terminal-inserted artifacts can be halved on flush. Preserve immediately
    // everywhere else — they are paragraph separators.
    if (line === '') {
      if (fenceDepth > 0 && fences) { pendingBlanks++; continue }
      out.push(line); lastOrigLen = 0; continue
    }

    // Flush buffered blanks before any content line inside a fence.
    if (fenceDepth > 0 && fences) flushPendingBlanks()

    // Inside fences: skip joining unless caller opted in. When opted in, use
    // lastOrigLen (the original pushed length, not the accumulated tail) so a
    // join doesn't immediately cascade into the next code line.
    if (fenceDepth > 0 && !fences) { out.push(line); lastOrigLen = line.length; continue }

    // Lines that unconditionally start a new block, regardless of how long
    // the previous line was. See the table in the block comment above.
    // Box-drawing chars always start a new unit — even inside fences, where
    // multi-line box frames (like shell prompts: ┌─ … └──) must not be joined.
    const isNewUnit = (
      /^[─-╿]/.test(line) ||
      (fenceDepth === 0 && (
        /^[●❯⎿✻>#*]/.test(line) ||
        /^- /.test(line)        ||  // list item (dash + space, not -shm/--flag)
        /^\d+\. /.test(line)    ||  // ordered list item
        /^-+\s*$/.test(line)        // all-ASCII-dash horizontal rule (---, ----)
      ))
    )

    const tailRaw = out[out.length - 1]  // raw stored line, trailing spaces preserved
    const tail = tailRaw?.trimEnd()  // trimmed copy used for content/joining only
    // For prose (outside fences), checkLen uses the raw stored length so that
    // terminal-padded user-turn lines (80 chars) always clear the threshold.
    // Inside fences, require BOTH the original push length AND the trimmed content
    // length to be long: short command outputs like "$ vite" are padded to 80 cols
    // by the terminal but have short visible content, so either signal alone would
    // misfire. The minimum of both prevents spurious joins.
    const checkLen = fenceDepth > 0
      ? Math.min(lastOrigLen, tail?.length ?? 0)
      : (tailRaw?.length ?? 0)
    // Comment lines (// or #) inside fences are prose: always word-separated,
    // never mid-identifier. Use the lower comment threshold and skip the
    // mid-word guard so even short-wrapped comment tails get joined.
    const isCommentTail = fenceDepth > 0 && /^\s*(?:\/\/|#)/.test(tail ?? '')
    const threshold = isCommentTail ? COMMENT_WRAP_THRESHOLD : WRAP_THRESHOLD

    if (!isNewUnit &&
        tail !== undefined && tail !== '' && !/^```/.test(tail) &&
        // A line ending with ':' introduces a new section/label; the following
        // line is intentionally on a new line, not a wrap continuation.
        !tail.endsWith(':') &&
        checkLen >= threshold) {
      // Mid-identifier terminal wrap: both sides are identifier chars inside a
      // non-comment fenced block — the terminal cut a word in half, so rejoin
      // without a space. Everything else (prose, comment lines, separator chars
      // like ',' or ')') uses a space as usual.
      const sep = (fenceDepth > 0 && !isCommentTail &&
        /[a-zA-Z0-9_]$/.test(tail) && /^[a-zA-Z0-9_]/.test(line.trimStart()))
        ? '' : ' '
      out[out.length - 1] = tail + sep + line.trimStart()
      if (fenceDepth > 0) lastOrigLen = 0  // one join per pushed code line; no cascade
    } else {
      out.push(line)
      lastOrigLen = line.length
    }
  }

  if (fences) flushPendingBlanks()

  return out.map(l => l.trimEnd()).join('\n')
}

// ---------------------------------------------------------------------------
// Main parser
// ---------------------------------------------------------------------------

export function parse(raw) {
  const lines = raw.split('\n')
  const events = []
  let i = 0

  // 1. Header block: everything before the first session-event sigil (❯ ● ✻).
  //    See "Cross-version compatibility" at the top of this file.
  const isSessionEvent = l =>
    (l.startsWith('❯') && (l.length === 1 || l[1] === ' ')) ||
    l.startsWith('● ') || l === '●' ||
    l.startsWith('✻ ')
  const firstEventIdx = lines.findIndex(isSessionEvent)
  if (firstEventIdx > 0) {
    let end = firstEventIdx
    while (end > 0 && lines[end - 1].trim() === '') end--
    const headerLines = lines.slice(0, end)
    if (headerLines.length > 0) {
      events.push({ type: 'header', lines: headerLines, meta: parseHeaderMeta(headerLines) })
    }
    i = firstEventIdx
  }

  // 2. Main body: dispatch on the leading sigil of each line.
  while (i < lines.length) {
    const line = lines[i]

    if (line.startsWith('❯') && (line.length === 1 || line[1] === ' ')) {
      i = parseUserTurn(lines, i, events)
    } else if (line.startsWith('● ') || line === '●') {
      i = parseAssistantTurn(lines, i, events)
    } else if (line.startsWith('✻ ')) {
      events.push({ type: 'thinking', content: line.slice(2).trim() })
      i++
      while (i < lines.length && lines[i].trim() === '') i++
    } else {
      i++
    }
  }

  return events
}

// ---------------------------------------------------------------------------
// Header metadata extraction
// ---------------------------------------------------------------------------
//
// Each pattern targets a specific substring, not a line/column position, so
// the results are independent of banner layout. Unknown fields produce a
// missing meta key; the renderer skips missing keys rather than breaking.
//
// Patterns and their stability assumptions:
//   version  "Claude Code vN.N.N"  — version string format
//   model    "Word N.N"            — model identifier before the first ·
//   plan     first · segment       — plan name; may be absent in future formats
//   user     "Welcome back Name!"  — old box format; or second · segment when
//                                    present (3-part model line, old format)
//   project  "~/path"              — tilde-relative project path

function parseHeaderMeta(lines) {
  const text = lines.join('\n')
  const meta = {}

  const welcome = text.match(/Welcome (?:back )?([^!│\n]+)!/)
  if (welcome) meta.user = welcome[1].trim()

  const modelMatch = text.match(/([A-Za-z]+ \d+\.\d+)((?:\s*·\s*[^·│\n]+)+)/m)
  if (modelMatch) {
    meta.model = modelMatch[1].trim()
    const parts = modelMatch[2].split('·').map(s => s.trim()).filter(Boolean)
    if (parts[0]) meta.plan = parts[0]
    if (parts[1] && !meta.user) meta.user = parts[1]
  }

  const project = text.match(/~\/[^\s│╰╭\n]+/)
  if (project) meta.project = project[0].trim()

  const version = text.match(/Claude Code v(\d+\.\d+\.\d+)/)
  if (version) meta.version = version[1]

  return meta
}

// ---------------------------------------------------------------------------
// User turn parser
// ---------------------------------------------------------------------------
//
// A user turn starts with ❯ and continues for all subsequent lines that are
// either 2-space indented or blank (blank only if the next non-blank line is
// also 2-space indented — that is, blank lines are paragraph separators
// WITHIN the turn, not turn terminators).
//
// Terminal detail: the terminal pads every user-turn line (including blank
// paragraphs) with trailing spaces to exactly 80 chars. A "blank" line looks
// like "                                                                      "
// (80 spaces), not "". We use line.trim() === '' to detect both forms.
//
// The ⎿ file-reference lines (near column 0 after stripping indent) are split
// out from prose and stored separately.

function parseUserTurn(lines, i, events) {
  const first = lines[i]
  const contentLines = [first.length > 1 ? first.slice(2) : '']
  i++

  while (i < lines.length) {
    const line = lines[i]

    if (line.trim() === '') {
      // A blank (or all-spaces-padded) line ends the turn only if the next
      // non-blank line is not 2-space indented — i.e. belongs to a different
      // event. If it IS indented, this blank is an in-paragraph separator.
      const next = lines[i + 1]
      if (!next || !next.startsWith('  ')) break
      contentLines.push('')
      i++
      continue
    }

    if (line.startsWith('  ')) {
      contentLines.push(line.slice(2))
      i++
    } else {
      break
    }
  }

  // Separate ⎿ file references from body text.
  // After stripping the 2-space export indent, a reference line starts with
  // HOOK at column 0; < 4 gives a small tolerance for any unusual leading
  // whitespace while still excluding HOOK sequences inside prose.
  const fileRefs = []
  const bodyLines = []
  for (const l of contentLines) {
    // UI expand hints like "Read 1 file (ctrl+o to expand)" are terminal
    // annotations, not part of the user's message.
    if (/\(ctrl\+o to expand\)\s*$/.test(l)) continue
    if (l.includes(HOOK) && l.indexOf(HOOK) < 4) {
      fileRefs.push(stripHook(l))
    } else {
      bodyLines.push(l)
    }
  }

  events.push({
    type: 'user',
    content: unwrapProse(bodyLines.join('\n').trimEnd(), { fences: true }),
    fileRefs,
  })

  while (i < lines.length && lines[i] === '') i++

  return i
}

// ---------------------------------------------------------------------------
// Assistant turn parser
// ---------------------------------------------------------------------------
//
// An assistant turn is a sequence of one or more ● blocks, each separated
// from the next by a blank line. Each block has:
//
//   ● <header text>  [⎿ inline result]    ← the ● line itself
//     <body line 1>                        ← 2-space indented continuation
//     <body line N>
//   ⎿  <result label>                     ← indented hook (separate from body)
//       NNN +added diff line              ← 4-space indented diff content
//       NNN -removed diff line
//
// A block with a header matching a known tool name is a `tool-call`; all
// others are `text`. Text blocks get prose-unwrapped header+body joined
// together so wraps right at the boundary are correctly re-joined.

function parseAssistantTurn(lines, i, events) {
  const blocks = []

  while (i < lines.length) {
    const line = lines[i]
    if (!(line.startsWith('● ') || line === '●')) break

    // The ● line may have an inline ⎿ result on the same line:
    //   "● Update(src/file.js)  ⎿  Added 2 lines, removed 2 lines"
    // Split it off so the header is just the tool call or prose text.
    let rawHeader = line.slice(2).trim()
    const inlineHookIdx = rawHeader.indexOf(HOOK)
    let inlineResult = null
    if (inlineHookIdx !== -1) {
      inlineResult = rawHeader.slice(inlineHookIdx + HOOK.length)
      rawHeader = rawHeader.slice(0, inlineHookIdx).trimEnd()
    }

    i++

    const bodyLines   = []
    const toolResults = []

    // pendingResultText / pendingDiffLines accumulate a tool result as we scan.
    // They start populated if there was an inline result on the ● line.
    let pendingResultText = inlineResult
    let pendingDiffLines  = inlineResult !== null ? [] : null

    while (i < lines.length) {
      const curr = lines[i]

      // An indented ⎿ line starts a new tool result. Flush the previous one
      // (if any) before starting the new accumulator.
      if (/^  ⎿/.test(curr)) {
        if (pendingResultText !== null) {
          toolResults.push(makeToolResult(pendingResultText, pendingDiffLines || []))
        }
        pendingResultText = stripHook(curr.trim())
        pendingDiffLines  = []
        i++
        continue
      }

      // Deeply indented lines after a tool result are diff content rows.
      if (pendingResultText !== null && /^\s{4}/.test(curr)) {
        pendingDiffLines.push(curr)
        i++
        continue
      }

      // Blank line: decides whether we're ending this ● block or staying in it.
      // Stay if the next non-blank line is still 2-space indented (in-block
      // paragraph). End if the next non-blank is a ● or is absent (new turn).
      // Strict equality (not trim): assistant lines are never space-padded by
      // the terminal, unlike user-turn lines where blank rows are 80 spaces.
      if (curr === '') {
        const next = lines[i + 1]
        if (!next || !next.startsWith('  ')) {
          i++
          break
        }
        if (pendingResultText === null) bodyLines.push('')
        i++
        continue
      }

      // 2-space indented body text (not ⎿)
      if (curr.startsWith('  ') && !/^  ⎿/.test(curr)) {
        bodyLines.push(curr.slice(2))
        i++
        continue
      }

      break
    }

    // Flush the last pending tool result.
    if (pendingResultText !== null) {
      toolResults.push(makeToolResult(pendingResultText, pendingDiffLines || []))
    }

    const blockType = classifyBlock(rawHeader)
    let header = rawHeader
    let body   = bodyLines.join('\n').trim()

    if (blockType === 'text') {
      // Merge header + body before unwrapping so a wrap right at the
      // header/body boundary (a common case) is correctly rejoined.
      const full      = body ? rawHeader + '\n' + body : rawHeader
      const unwrapped = unwrapProse(full)
      const cut       = unwrapped.indexOf('\n')
      if (cut === -1) { header = unwrapped; body = '' }
      else            { header = unwrapped.slice(0, cut); body = unwrapped.slice(cut + 1).trim() }
    } else {
      // Tool call bodies are prose descriptions — unwrap them, but not the
      // header (which is a function signature that must stay intact).
      body = unwrapProse(body)
    }

    blocks.push({ header, body, toolResults, blockType })

    // Skip blank lines between ● blocks in the same assistant turn.
    while (i < lines.length && lines[i] === '') i++
  }

  if (blocks.length > 0) events.push({ type: 'assistant', blocks })

  while (i < lines.length && lines[i] === '') i++

  return i
}

// ---------------------------------------------------------------------------
// Block type classifier
// ---------------------------------------------------------------------------
//
// A block is a `tool-call` if its header starts with a known tool name
// followed by '(' or '['. Everything else is treated as prose `text`.
// The tool list must match the actual Claude Code tool names; unknown tools
// fall through to `text` (gracefully degraded rendering).

const TOOL_RE = /^(Read|Write|Edit|Bash|Update|Delete|Glob|Grep|MultiEdit|WebFetch|WebSearch|Agent|Task\w*|NotebookEdit|AskUser\w*|Skill|ToolSearch|Cron\w*|Monitor|PushNotification|RemoteTrigger|ScheduleWakeup|EnterPlanMode|ExitPlanMode|EnterWorktree|ExitWorktree|mcp__\w+)\s*[\(\[]/

function classifyBlock(header) {
  return TOOL_RE.test(header) ? 'tool-call' : 'text'
}
