// SolidJS component tree for the live interactive SPA and the full-featured export.
//
// This file is the reactive counterpart to render.js: both produce the same HTML
// structure with the same CSS class names, but here the output is a live Solid
// component tree rather than an HTML string.
//
// The duplication is intentional. The static export must produce zero-JS HTML with
// no hydration markers, which rules out renderToString(). The dynamic export reuses
// the string builder for session content and adds only a tiny vanilla switcher —
// theme switching is a single attribute swap that doesn't need a framework. Only
// the full-featured export uses these components directly, via the inlined production
// bundle re-rendering from embedded session JSON.
//
// Pure logic shared by both rendering paths — splitFencedBlocks() and parseToolHeader() —
// is imported from render.js as their single source of truth.

import { For, Show, createMemo } from 'solid-js'
import { splitFencedBlocks, parseToolHeader } from '../render.js'

// ---------------------------------------------------------------------------
// Inline markup renderer
// Splits text on backtick spans (`code`) and renders them as <code> elements.
// Everything else is plain text. Used inside prose segments.
// ---------------------------------------------------------------------------

function InlineText(props) {
  const parts = createMemo(() => {
    const text = props.text || ''
    // Splitting with a capturing group keeps the matched text in the result array
    // at odd indices: ["before", "`code`", "after"]. Even indices are plain text;
    // odd indices are code spans (still wrapped in backticks, so slice(1,-1) strips them).
    return text.split(/(`[^`]+`)/g).map((part, i) => {
      if (i % 2 === 1) return { code: true, content: part.slice(1, -1) }
      return { code: false, content: part }
    })
  })

  return (
    <For each={parts()}>
      {part => part.code
        ? <code>{part.content}</code>
        : <span>{part.content}</span>
      }
    </For>
  )
}

// Splits text on fenced code blocks (``` … ```) and renders each segment
// appropriately: prose segments use InlineText, fenced blocks use <pre>.
function RichText(props) {
  const segments = createMemo(() => splitFencedBlocks(props.text || ''))

  return (
    <For each={segments()}>
      {seg => seg.fenced
        ? <pre class="fenced-block">{seg.content}</pre>
        : <span class="inline-prose"><InlineText text={seg.content} /></span>
      }
    </For>
  )
}

// ---------------------------------------------------------------------------
// Diff line renderer
// ---------------------------------------------------------------------------

function DiffLine(props) {
  const line = () => props.line
  return (
    <div class={`diff-line ${line().type === 'raw' ? 'wrap' : line().type}`}>
      <span class="diff-line-num">{line().lineNum || ''}</span>
      <span class="diff-line-content">
        <span class="diff-type-char">{line().type === 'added' ? '+' : line().type === 'removed' ? '-' : ' '}</span>
        {line().content}
      </span>
    </div>
  )
}

function DiffBlock(props) {
  return (
    <div class="diff-block">
      <div class="diff-inner">
        <For each={props.lines}>
          {line => <DiffLine line={line} />}
        </For>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Tool result renderer
// Shows the ⎿ result label and optional diff block below a tool call.
// ---------------------------------------------------------------------------

function ToolResult(props) {
  const result = () => props.result
  return (
    <div class="tool-result">
      <div class="tool-result-label">
        <span>{result().text}</span>
      </div>
      <Show when={result().diff}>
        <DiffBlock lines={result().diff} />
      </Show>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Assistant block renderer (single ● block)
// A block is either a text message or a tool call, determined by blockType.
// ---------------------------------------------------------------------------

function AssistantBlock(props) {
  const block = () => props.block
  const isToolCall = () => block().blockType === 'tool-call'
  const tool = createMemo(() => parseToolHeader(block().header))

  return (
    <div class={`assistant-block ${isToolCall() ? 'block-tool' : 'block-text'}`}>
      <div class="turn-gutter">
        <span class={`turn-icon ${isToolCall() ? 'tool-icon' : ''}`}>●</span>
      </div>
      <div class="turn-body">
        <Show
          when={isToolCall()}
          fallback={
            <>
              <div class="block-text-header">
                <RichText text={block().header} />
              </div>
              <Show when={block().body}>
                <div class="block-text-body">
                  <RichText text={block().body} />
                </div>
              </Show>
            </>
          }
        >
          <div class="tool-header">
            <span class="tool-name">{tool().name}</span>
            <span class="tool-args">{tool().args}</span>
          </div>
          <Show when={block().body}>
            <div class="block-text-body">
              <RichText text={block().body} />
            </div>
          </Show>
        </Show>
        <For each={block().toolResults}>
          {result => <ToolResult result={result} />}
        </For>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Event renderers (top-level session blocks)
// ---------------------------------------------------------------------------

export function HeaderBlock(props) {
  const meta = () => props.event.meta

  return (
    <div class="block-header-meta">
      <div class="header-brand-row">
        <span class="header-brand-mark">◆</span>
        <span class="header-brand-name">claude session</span>
        <div class="header-chips">
          <Show when={meta().model}>
            <span class="header-chip chip-model">{meta().model}</span>
          </Show>
          <Show when={meta().plan}>
            <span class="header-chip chip-plan">{meta().plan}</span>
          </Show>
          <Show when={meta().version}>
            <span class="header-chip chip-version">v{meta().version}</span>
          </Show>
        </div>
      </div>
      <Show when={meta().user || meta().project}>
        <div class="header-identity-row">
          <Show when={meta().user}>
            <span class="header-identity-user">{meta().user}</span>
          </Show>
          <Show when={meta().user && meta().project}>
            <span class="header-identity-sep">·</span>
          </Show>
          <Show when={meta().project}>
            <span class="header-identity-project" title={meta().project}>
              {meta().project}
            </span>
          </Show>
        </div>
      </Show>
    </div>
  )
}

export function UserBlock(props) {
  const event = () => props.event
  return (
    <div class="turn turn-user">
      <div class="turn-gutter">
        <span class="turn-icon">❯</span>
      </div>
      <div class="turn-body">
        <div class="user-content">
          <RichText text={event().content} />
        </div>
        <Show when={event().fileRefs.length > 0}>
          <div class="user-filerefs">
            <For each={event().fileRefs}>
              {ref => <span class="user-fileref">{ref}</span>}
            </For>
          </div>
        </Show>
      </div>
    </div>
  )
}

export function AssistantTurn(props) {
  return (
    <div class="turn turn-assistant">
      <For each={props.event.blocks}>
        {block => <AssistantBlock block={block} />}
      </For>
    </div>
  )
}

export function ThinkingBlock(props) {
  return (
    <div class="turn turn-thinking">
      <div class="turn-gutter" />
      <div class="turn-body">
        <span class="thinking-content">✻ {props.event.content}</span>
      </div>
    </div>
  )
}
