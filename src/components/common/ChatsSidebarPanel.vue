<script setup lang="ts">
import { ref, computed, nextTick, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { MessageSquare, X, ArrowLeft, Send, Ban } from 'lucide-vue-next'
import { useMessageStore } from '@/composables/useMessageStore'
import { useSidePanels } from '@/composables/useSidePanels'
import { useDraftStore } from '@/composables/useDraftStore'
import { formatRelativeTime, fmtTime } from '@/utils/format'

const { t } = useI18n()
const messages = useMessageStore()
const panels = useSidePanels()
const store = useDraftStore()

const draft = ref('')
const sending = ref(false)
const sendError = ref('')

const MAX = 200
const remaining = computed(() => MAX - draft.value.length)
const overLimit = computed(() => remaining.value < 0)

const me = computed(() => store.currentUser.value)
const isLoggedIn = computed(() => !!me.value)

const scrollEl = ref<HTMLElement | null>(null)
async function scrollToBottom() {
  await nextTick()
  const el = scrollEl.value
  if (el) el.scrollTop = el.scrollHeight
}
watch(() => messages.currentMessages.value, scrollToBottom, { flush: 'post' })
watch(() => messages.currentPeerId.value, scrollToBottom, { flush: 'post' })
watch(() => panels.active.value, (a) => {
  if (a === 'chats') scrollToBottom()
})

async function send() {
  const body = draft.value.trim()
  if (!body || overLimit.value || sending.value) return
  sending.value = true
  sendError.value = ''
  const res = await messages.sendMessage(body)
  if (res.ok) {
    draft.value = ''
  } else {
    sendError.value = res.error || t('messageSendFailed')
  }
  sending.value = false
}

function initialOf(p: { display_name: string | null; name: string }): string {
  return (p.display_name || p.name || '?').charAt(0).toUpperCase()
}

function isMine(senderId: number): boolean {
  return !!me.value && me.value.id === senderId
}

function formatHeaderTime(iso: string): string {
  return fmtTime(new Date(iso))
}
</script>

<template>
  <Teleport to="body">
    <Transition name="slide-right">
      <aside
        v-if="panels.active.value === 'chats'"
        class="fixed top-0 bottom-0 w-[320px] z-50 flex flex-col shadow-[0_0_60px_0_rgba(0,0,0,0.8)] md:right-[70px] right-0"
        style="background:#0F172A;border-left:1px solid #22D3EE;border-right:1px solid #1E293B"
      >
        <!-- Header -->
        <div
          class="flex items-center justify-between h-[54px] px-[18px] shrink-0"
          style="background:#0A0F1C;border-bottom:1px solid #1E293B"
        >
          <div class="flex items-center gap-2 min-w-0">
            <button
              v-if="messages.currentPeerId.value !== null"
              class="w-[22px] h-[22px] rounded-md flex items-center justify-center transition-colors hover:bg-white/5"
              :title="t('back')"
              @click="messages.closeThread()"
            >
              <ArrowLeft class="w-[14px] h-[14px]" style="color:#94A3B8" />
            </button>
            <MessageSquare v-else class="w-[15px] h-[15px]" style="color:#22D3EE" />
            <span class="text-[15px] font-extrabold truncate" style="color:#F1F5F9">
              {{ messages.currentPeer.value ? (messages.currentPeer.value.display_name || messages.currentPeer.value.name) : t('messages') }}
            </span>
          </div>
          <button
            class="w-[26px] h-[26px] rounded-md flex items-center justify-center transition-colors hover:opacity-80"
            style="background:#1E293B"
            :title="t('close')"
            @click="panels.close()"
          >
            <X class="w-[13px] h-[13px]" style="color:#94A3B8" />
          </button>
        </div>

        <!-- Not logged in -->
        <div v-if="!isLoggedIn" class="flex-1 flex items-center justify-center px-6 text-center text-[12px]" style="color:#475569">
          {{ t('loginToMessage') }}
        </div>

        <!-- Conversation view -->
        <template v-else-if="messages.currentPeerId.value !== null">
          <div ref="scrollEl" class="flex-1 overflow-y-auto px-3 py-3 flex flex-col gap-1.5">
            <div
              v-if="messages.currentMessages.value.length === 0"
              class="flex-1 flex items-center justify-center text-[12px]"
              style="color:#475569"
            >
              {{ t('noMessagesYet') }}
            </div>
            <template v-for="m in messages.currentMessages.value" :key="m.id">
              <div
                class="flex"
                :class="isMine(m.sender_id) ? 'justify-end' : 'justify-start'"
              >
                <div
                  class="max-w-[78%] rounded-2xl px-3 py-2 text-[13px] leading-snug break-words"
                  :style="isMine(m.sender_id)
                    ? 'background:#22D3EE;color:#0A0F1C'
                    : 'background:#1E293B;color:#F1F5F9'"
                >
                  <div class="whitespace-pre-wrap">{{ m.body }}</div>
                  <div
                    class="text-[10px] mt-0.5 text-right"
                    :style="isMine(m.sender_id) ? 'color:rgba(10,15,28,0.6)' : 'color:#64748B'"
                  >
                    {{ formatHeaderTime(m.created_at) }}
                    <template v-if="isMine(m.sender_id) && m.read_at"> · {{ t('messageRead') }}</template>
                  </div>
                </div>
              </div>
            </template>
          </div>

          <!-- Composer -->
          <div class="px-3 py-3 shrink-0" style="border-top:1px solid #1E293B;background:#0A0F1C">
            <div
              class="flex items-end gap-2 rounded-md p-2"
              style="background:#0F172A;box-shadow:inset 0 0 0 1px #1E293B"
            >
              <textarea
                v-model="draft"
                rows="1"
                :maxlength="MAX + 50"
                :placeholder="t('typeAMessage')"
                class="flex-1 bg-transparent outline-none resize-none text-[13px] leading-snug max-h-[80px]"
                style="color:#F1F5F9"
                @keydown.enter.exact.prevent="send()"
              />
              <button
                class="w-8 h-8 rounded-md flex items-center justify-center transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                :style="(!draft.trim() || overLimit) ? 'background:#1E293B' : 'background:#22D3EE'"
                :disabled="!draft.trim() || overLimit || sending"
                :title="t('send')"
                @click="send()"
              >
                <Send
                  class="w-4 h-4"
                  :style="{ color: (!draft.trim() || overLimit) ? '#475569' : '#0A0F1C' }"
                />
              </button>
            </div>
            <div class="flex items-center justify-between mt-1.5 px-1">
              <span v-if="sendError" class="text-[11px] flex items-center gap-1" style="color:#FCA5A5">
                <Ban class="w-3 h-3" />
                {{ sendError }}
              </span>
              <span v-else class="text-[11px]" style="color:#475569">{{ t('enterToSend') }}</span>
              <span
                class="text-[11px] font-mono"
                :style="{ color: overLimit ? '#EF4444' : (remaining < 30 ? '#FACC15' : '#475569') }"
              >{{ remaining }}</span>
            </div>
          </div>
        </template>

        <!-- Thread list -->
        <template v-else>
          <div class="flex-1 overflow-y-auto">
            <div
              v-if="messages.threads.value.length === 0"
              class="px-6 py-12 text-center text-[12px]"
              style="color:#475569"
            >
              {{ t('noChatsYet') }}
            </div>
            <button
              v-for="t in messages.threads.value"
              :key="t.peer.id"
              class="w-full flex items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-white/5"
              @click="messages.openThread(t.peer)"
            >
              <div
                class="w-10 h-10 rounded-full flex items-center justify-center shrink-0 overflow-hidden"
                style="background:#1E293B"
              >
                <img v-if="t.peer.avatar_url" :src="t.peer.avatar_url" class="w-full h-full object-cover" />
                <span v-else class="text-white text-[14px] font-extrabold">{{ initialOf(t.peer) }}</span>
              </div>
              <div class="flex-1 min-w-0">
                <div class="flex items-center justify-between gap-2">
                  <span class="text-[13px] font-bold truncate" style="color:#F1F5F9">
                    {{ t.peer.display_name || t.peer.name }}
                  </span>
                  <span class="text-[10px] shrink-0" style="color:#64748B">
                    {{ formatRelativeTime(t.last_message.created_at) }}
                  </span>
                </div>
                <div class="flex items-center justify-between gap-2 mt-0.5">
                  <span
                    class="text-[11px] truncate"
                    :style="{ color: t.unread > 0 ? '#F1F5F9' : '#94A3B8', fontWeight: t.unread > 0 ? '600' : 'normal' }"
                  >
                    <template v-if="t.last_message.sender_id === me?.id">{{ $t('youPrefix') }}: </template>{{ t.last_message.body }}
                  </span>
                  <span
                    v-if="t.unread > 0"
                    class="inline-flex items-center justify-center text-[9px] font-black px-[6px] rounded text-white shrink-0"
                    style="background:#EF4444;min-width:16px;height:16px"
                  >{{ t.unread }}</span>
                </div>
              </div>
            </button>
          </div>
        </template>
      </aside>
    </Transition>
  </Teleport>
</template>

<style scoped>
.slide-right-enter-active,
.slide-right-leave-active {
  transition: transform 220ms ease;
}
.slide-right-enter-from,
.slide-right-leave-to {
  transform: translateX(100%);
}
</style>
