<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { streamAgent, type AgentEvent } from '@/lib/api'
import { useAppStore } from '@/stores/app'
import { useGraphStore } from '@/stores/graph'

/**
 * The troubleshooting agent.
 *
 * Tool calls are shown as they happen rather than hidden behind a spinner. The
 * agent's answers are only as good as what it actually read, and showing which
 * tools ran — and what each returned — is what lets someone judge an answer
 * instead of taking it on trust.
 */

const app = useAppStore()
const graph = useGraphStore()

interface Turn {
  role: 'user' | 'assistant'
  content: string
  /** Tool activity recorded during an assistant turn, in order. */
  steps: Array<{ name: string; summary: string | null; ok: boolean | null }>
}

const turns = ref<Turn[]>([])
const draft = ref('')
const running = ref(false)
const error = ref<string | null>(null)
const scroller = ref<HTMLElement | null>(null)

let cancel: (() => void) | null = null

const ready = computed(() => app.info?.agentReady === true)

const SUGGESTIONS = [
  'What is wrong right now?',
  'Why is this resource unhealthy?',
  'Did anything change in the last hour?',
]

async function scrollDown(): Promise<void> {
  await nextTick()
  const element = scroller.value
  if (element) element.scrollTop = element.scrollHeight
}

function send(text?: string): void {
  const content = (text ?? draft.value).trim()
  if (content.length === 0 || running.value) return
  draft.value = ''
  error.value = null

  turns.value = [...turns.value, { role: 'user', content, steps: [] }]
  const assistant: Turn = { role: 'assistant', content: '', steps: [] }
  turns.value = [...turns.value, assistant]
  running.value = true
  void scrollDown()

  // Only the text is sent back as history: tool results are already in the
  // model's own transcript on the server side for the turn that produced them.
  const history = turns.value
    .filter((turn) => turn.content.length > 0)
    .map((turn) => ({ role: turn.role, content: turn.content }))

  cancel = streamAgent(
    { messages: history, selectedNodeId: graph.selectedNode?.id ?? null },
    {
      onEvent: (event: AgentEvent) => {
        if (event.type === 'text') assistant.content += event.text
        else if (event.type === 'tool') {
          assistant.steps.push({ name: event.name, summary: null, ok: null })
        } else if (event.type === 'tool_result') {
          const step = [...assistant.steps].reverse().find((entry) => entry.name === event.name && entry.summary === null)
          if (step) {
            step.summary = event.summary
            step.ok = event.ok
          }
        } else if (event.type === 'error') error.value = event.message
        void scrollDown()
      },
      onClose: () => {
        running.value = false
        cancel = null
        // An assistant turn that produced nothing is removed, so the transcript
        // does not show an empty bubble as if it were an answer.
        if (assistant.content.length === 0 && assistant.steps.length === 0) {
          turns.value = turns.value.filter((turn) => turn !== assistant)
        }
      },
    },
  )
}

function stop(): void {
  cancel?.()
  cancel = null
  running.value = false
}

watch(() => app.agentOpen, (open) => { if (!open) stop() })
onBeforeUnmount(stop)
</script>

<template>
  <aside
    v-if="app.agentOpen"
    class="flex h-full w-[380px] shrink-0 flex-col border-l border-border bg-panel"
  >
    <div class="flex items-center gap-2 border-b border-border px-4 py-[11px]">
      <span class="text-[12.5px] font-medium">Ask Claude</span>
      <span v-if="graph.selectedNode" class="truncate text-[11px] text-faint">
        · {{ graph.selectedNode.name }}
      </span>
      <button
        type="button"
        class="ml-auto cursor-pointer text-[15px] leading-none text-faint hover:text-text"
        aria-label="Close"
        @click="app.agentOpen = false"
      >
        ×
      </button>
    </div>

    <div v-if="!ready" class="px-4 py-4">
      <p class="text-[11.5px] leading-[1.6] text-muted">
        Set <span class="font-mono text-text">ANTHROPIC_API_KEY</span> in
        <span class="font-mono text-text">.env</span> to enable the agent, then restart.
      </p>
      <p class="mt-2 text-[11.5px] leading-[1.6] text-faint">
        Your AWS credentials are never sent to the API. The agent reads this account through the
        same read-only tools the rest of CloudAtlas uses.
      </p>
    </div>

    <template v-else>
      <div ref="scroller" class="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        <div v-if="turns.length === 0" class="flex flex-col gap-[6px]">
          <p class="mb-1 text-[11.5px] leading-[1.6] text-muted">
            Ask about this account. Every answer is grounded in a read-only tool call, and the calls
            are shown so you can check the reasoning.
          </p>
          <button
            v-for="suggestion in SUGGESTIONS"
            :key="suggestion"
            type="button"
            class="cursor-pointer rounded-[7px] border border-border bg-panel2 px-[9px] py-[6px] text-left text-[11.5px] text-muted transition-colors hover:border-border2 hover:text-text"
            @click="send(suggestion)"
          >
            {{ suggestion }}
          </button>
        </div>

        <div v-for="(turn, index) in turns" :key="index" class="mb-3 last:mb-0">
          <div
            v-if="turn.role === 'user'"
            class="ml-auto w-fit max-w-[90%] rounded-[8px] bg-raise px-[10px] py-[6px] text-[11.5px] leading-[1.55]"
          >
            {{ turn.content }}
          </div>

          <div v-else>
            <div v-if="turn.steps.length > 0" class="mb-[6px] flex flex-col gap-[3px]">
              <div
                v-for="(step, stepIndex) in turn.steps"
                :key="stepIndex"
                class="flex items-center gap-[6px] text-[10.5px]"
              >
                <span
                  class="h-[5px] w-[5px] shrink-0 rounded-full"
                  :class="step.ok === null ? 'bg-warn' : step.ok ? 'bg-ok' : 'bg-bad'"
                />
                <span class="font-mono text-faint">{{ step.name }}</span>
                <span v-if="step.summary" class="min-w-0 truncate text-faint">
                  · {{ step.summary }}
                </span>
              </div>
            </div>
            <p class="whitespace-pre-wrap text-[11.5px] leading-[1.65] text-text">{{
              turn.content
            }}</p>
          </div>
        </div>

        <p v-if="error" class="mt-2 rounded-[6px] border border-bad/40 bg-bad/10 px-[9px] py-[6px] text-[11.5px] text-bad">
          {{ error }}
        </p>
      </div>

      <div class="border-t border-border p-3">
        <div class="flex items-end gap-2">
          <textarea
            v-model="draft"
            rows="2"
            placeholder="Ask about this account…"
            class="min-w-0 flex-1 resize-none rounded-[7px] border border-border bg-panel2 px-[9px] py-[7px] text-[11.5px] leading-[1.5] text-text placeholder:text-faint focus:border-border2 focus:outline-none"
            @keydown.enter.exact.prevent="send()"
          />
          <button
            type="button"
            class="h-[30px] shrink-0 cursor-pointer rounded-[7px] border border-border2 bg-raise px-[11px] text-[11.5px] text-text disabled:opacity-50"
            :disabled="!running && draft.trim().length === 0"
            @click="running ? stop() : send()"
          >
            {{ running ? 'Stop' : 'Send' }}
          </button>
        </div>
      </div>
    </template>
  </aside>
</template>
