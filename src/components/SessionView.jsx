import { For, Switch, Match } from 'solid-js'
import { HeaderBlock, UserBlock, AssistantTurn, ThinkingBlock } from './Block.jsx'

export function SessionView(props) {
  return (
    <div class="session-wrap">
      <div class="session">
        <For each={props.events}>
          {event => (
            <Switch>
              <Match when={event.type === 'header'}>
                <HeaderBlock event={event} />
              </Match>
              <Match when={event.type === 'user'}>
                <UserBlock event={event} />
              </Match>
              <Match when={event.type === 'assistant'}>
                <AssistantTurn event={event} />
              </Match>
              <Match when={event.type === 'thinking'}>
                <ThinkingBlock event={event} />
              </Match>
            </Switch>
          )}
        </For>
        <div class="obsession-footer">
          <a href="https://specious.github.io/obsession/" target="_blank" rel="noopener">generated with obsession</a>
        </div>
      </div>
    </div>
  )
}
