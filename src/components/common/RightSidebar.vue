<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Bell, Users, MessageSquare, User } from 'lucide-vue-next'
import { useDraftStore } from '@/composables/useDraftStore'
import { useFriendStore } from '@/composables/useFriendStore'
import { useNotificationStore } from '@/composables/useNotificationStore'
import { useSidePanels } from '@/composables/useSidePanels'

const panels = useSidePanels()

const friendStore = useFriendStore()
const notifStore = useNotificationStore()

const FRIEND_GRADIENTS = [
  'linear-gradient(135deg,#F59E0B,#EF4444)',
  'linear-gradient(135deg,#22C55E,#0891B2)',
  'linear-gradient(135deg,#6366F1,#A21CAF)',
  'linear-gradient(135deg,#EC4899,#F59E0B)',
]
function gradientFor(playerId: number): string {
  return FRIEND_GRADIENTS[playerId % FRIEND_GRADIENTS.length]
}
function initialFor(entry: any): string {
  const n = entry?.player?.display_name || entry?.player?.name || '?'
  return n.charAt(0).toUpperCase()
}

const { t } = useI18n()
const store = useDraftStore()

const user = computed(() => store.currentUser.value)
const initial = computed(() => {
  const n = user.value?.display_name || user.value?.name || user.value?.steam_name || '?'
  return n.charAt(0).toUpperCase()
})

function openProfilePanel() {
  panels.openProfile()
}
</script>

<template>
  <aside
    v-if="user"
    class="hidden md:flex flex-col items-center shrink-0 w-[70px] py-[18px] gap-[14px] border-l relative z-[60]"
    style="background:#0A0F1C;border-color:#1E293B"
  >
    <!-- Avatar with online dot -->
    <button
      class="relative w-[44px] h-[44px] rounded-full overflow-hidden flex items-center justify-center"
      style="background:linear-gradient(135deg,#22D3EE,#A21CAF)"
      :title="user.display_name || user.name"
      @click="openProfilePanel"
    >
      <img v-if="user.avatar_url" :src="user.avatar_url" class="w-full h-full object-cover" />
      <span v-else class="text-white text-[18px] font-extrabold">{{ initial }}</span>
      <span
        class="absolute right-[-2px] bottom-[-2px] w-[11px] h-[11px] rounded-full"
        style="background:#22C55E;box-shadow:inset 0 0 0 2px #0A0F1C"
      />
    </button>

    <!-- MMR stack -->
    <div class="flex flex-col items-center gap-[1px] leading-none">
      <span class="text-[13px] font-extrabold font-mono" style="color:#22D3EE">{{ user.mmr || 0 }}</span>
      <span
        class="text-[10px] font-bold"
        :style="{ color: user.mmr_verified_at ? '#22C55E' : '#64748B' }"
      >
        {{ user.mmr_verified_at ? '✓' : '—' }}
      </span>
    </div>

    <!-- Bell — opens Notifications panel -->
    <button class="rail-btn relative" :title="t('notifications')" @click="panels.openNotifications()">
      <Bell class="w-4 h-4" style="color:#CBD5E1" />
      <span
        v-if="notifStore.unreadCount.value > 0"
        class="absolute inline-flex items-center justify-center text-[9px] font-black px-[3px] rounded text-white"
        style="top:6px;right:2px;min-width:14px;height:12px;background:#EF4444"
      >{{ notifStore.unreadCount.value }}</span>
    </button>

    <!-- Friends — opens Friends panel -->
    <button class="rail-btn relative" :title="t('friends')" @click="panels.openFriends()">
      <Users class="w-4 h-4" style="color:#CBD5E1" />
      <span
        v-if="friendStore.friends.value.length > 0"
        class="absolute inline-flex items-center justify-center text-[9px] font-black px-[3px] rounded"
        style="top:6px;right:2px;min-width:14px;height:12px;background:#22D3EE;color:#0A0F1C"
      >{{ friendStore.friends.value.length }}</span>
    </button>

    <div class="w-[38px] h-px" style="background:#1E293B" />

    <!-- Messages — opens Chats panel -->
    <button class="rail-btn relative" :title="t('messages')" @click="panels.openChats()">
      <MessageSquare class="w-4 h-4" style="color:#CBD5E1" />
    </button>

    <!-- Friend tiles (first 2 friends) -->
    <router-link
      v-for="f in friendStore.friends.value.slice(0, 2)"
      :key="f.id"
      :to="{ name: 'player-profile', params: { id: f.player.id } }"
      class="relative w-[38px] h-[38px] rounded-full flex items-center justify-center"
      :style="{ background: gradientFor(f.player.id) }"
      :title="f.player.display_name || f.player.name"
    >
      <img v-if="f.player.avatar_url" :src="f.player.avatar_url" class="w-full h-full rounded-full object-cover" />
      <span v-else class="text-white text-[15px] font-extrabold">{{ initialFor(f) }}</span>
      <span
        v-if="f.online"
        class="absolute right-[-2px] bottom-[-2px] w-[10px] h-[10px] rounded-full"
        style="background:#22C55E;box-shadow:inset 0 0 0 2px #0A0F1C"
      />
    </router-link>

  </aside>
</template>

<style scoped>
.rail-btn {
  width: 38px;
  height: 38px;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: inset 0 0 0 1px #1E293B;
  transition: background-color 0.15s;
}
.rail-btn:hover {
  background: rgba(255, 255, 255, 0.04);
}
.rail-btn-active {
  background: #0B1A2E;
  box-shadow: inset 0 0 0 1px #1E3A5F;
}
</style>
