<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { Bell, X, CheckCheck } from 'lucide-vue-next'
import { useNotificationStore } from '@/composables/useNotificationStore'
import { useSidePanels } from '@/composables/useSidePanels'
import { formatRelativeTime } from '@/utils/format'

const { t } = useI18n()
const notifStore = useNotificationStore()
const panels = useSidePanels()
</script>

<template>
  <Teleport to="body">
    <Transition name="slide-right">
      <aside
        v-if="panels.active.value === 'notifications'"
        class="fixed top-0 bottom-0 w-[320px] z-50 flex flex-col shadow-[0_0_60px_0_rgba(0,0,0,0.8)] md:right-[70px] right-0"
        style="background:#0F172A;border-left:1px solid #22D3EE;border-right:1px solid #1E293B"
      >
        <!-- Header -->
        <div
          class="flex items-center justify-between h-[54px] px-[18px] shrink-0"
          style="background:#0A0F1C;border-bottom:1px solid #1E293B"
        >
          <div class="flex items-center gap-2">
            <Bell class="w-[15px] h-[15px]" style="color:#22D3EE" />
            <span class="text-[15px] font-extrabold" style="color:#F1F5F9">
              {{ t('notifications') }}
            </span>
            <span
              v-if="notifStore.unreadCount.value > 0"
              class="inline-flex items-center justify-center text-[10px] font-black px-[6px] rounded text-white"
              style="background:#EF4444"
            >{{ notifStore.unreadCount.value }}</span>
          </div>
          <div class="flex items-center gap-1.5">
            <button
              v-if="notifStore.unreadCount.value > 0"
              class="w-[26px] h-[26px] rounded-md flex items-center justify-center transition-colors hover:bg-white/5"
              style="box-shadow:inset 0 0 0 1px #1E293B"
              :title="t('markAllRead')"
              @click="notifStore.markAllRead()"
            >
              <CheckCheck class="w-[13px] h-[13px]" style="color:#22D3EE" />
            </button>
            <button
              class="w-[26px] h-[26px] rounded-md flex items-center justify-center transition-colors hover:opacity-80"
              style="background:#1E293B"
              :title="t('close')"
              @click="panels.close()"
            >
              <X class="w-[13px] h-[13px]" style="color:#94A3B8" />
            </button>
          </div>
        </div>

        <!-- Body -->
        <div class="flex-1 overflow-y-auto">
          <div
            v-if="notifStore.rows.value.length === 0"
            class="px-6 py-12 text-center text-[12px]"
            style="color:#475569"
          >
            {{ t('noNotifications') }}
          </div>
          <div v-else class="flex flex-col gap-1 px-[10px] py-3">
            <component
              :is="n.link ? 'a' : 'div'"
              v-for="n in notifStore.rows.value"
              :key="n.id"
              :href="n.link || undefined"
              :target="n.link ? '_blank' : undefined"
              :rel="n.link ? 'noopener' : undefined"
              class="flex gap-2.5 rounded-md p-2.5 transition-colors hover:bg-white/5 cursor-pointer"
              :style="{ background: n.read_at ? 'transparent' : 'rgba(34,211,238,0.05)', boxShadow: n.read_at ? 'none' : 'inset 0 0 0 1px rgba(34,211,238,0.2)' }"
              @click="!n.read_at && notifStore.markRead(n.id)"
            >
              <span
                class="mt-1 w-1.5 h-1.5 rounded-full shrink-0"
                :style="{ background: n.read_at ? '#475569' : '#22D3EE' }"
              />
              <div class="flex-1 min-w-0">
                <div class="text-[13px] font-bold truncate" :style="{ color: n.read_at ? '#94A3B8' : '#F1F5F9' }">
                  {{ n.title }}
                </div>
                <div v-if="n.body" class="text-[11px] mt-0.5 whitespace-pre-wrap" style="color:#94A3B8">
                  {{ n.body }}
                </div>
                <div class="text-[10px] mt-1" style="color:#475569">{{ formatRelativeTime(n.created_at) }}</div>
              </div>
            </component>
          </div>
        </div>
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
