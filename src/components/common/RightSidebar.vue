<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { Bell, Users, MessageSquare, Plus, Headphones, User } from 'lucide-vue-next'
import { useDraftStore } from '@/composables/useDraftStore'
import { useFriendStore } from '@/composables/useFriendStore'

const friendStore = useFriendStore()

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
const route = useRoute()
const router = useRouter()
const store = useDraftStore()

const user = computed(() => store.currentUser.value)
const initial = computed(() => {
  const n = user.value?.display_name || user.value?.name || user.value?.steam_name || '?'
  return n.charAt(0).toUpperCase()
})

const onQueueRoute = computed(() => route.path === '/queue')

function goToQueue() {
  if (!onQueueRoute.value) router.push('/queue')
}

function goToProfile() {
  if (user.value?.id) router.push({ name: 'player-profile', params: { id: user.value.id } })
}
</script>

<template>
  <aside
    v-if="user"
    class="hidden md:flex flex-col items-center shrink-0 w-[70px] py-[18px] gap-[14px] border-l"
    style="background:#0A0F1C;border-color:#1E293B"
  >
    <!-- Avatar with online dot -->
    <button
      class="relative w-[44px] h-[44px] rounded-full overflow-hidden flex items-center justify-center"
      style="background:linear-gradient(135deg,#22D3EE,#A21CAF)"
      :title="user.display_name || user.name"
      @click="goToProfile"
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

    <!-- VS / Find match -->
    <button
      class="rail-btn"
      :class="onQueueRoute ? 'rail-btn-active' : ''"
      :title="t('findMatch')"
      @click="goToQueue"
    >
      <span class="text-[13px] font-black tracking-[0.5px]" style="color:#22D3EE">VS</span>
    </button>

    <!-- Bell (placeholder) -->
    <button class="rail-btn relative" :title="t('notifications')">
      <Bell class="w-4 h-4" style="color:#CBD5E1" />
      <span class="absolute w-2 h-2 rounded-full" style="top:8px;right:8px;background:#EF4444;box-shadow:inset 0 0 0 1px #0A0F1C" />
    </button>

    <!-- Party (placeholder) -->
    <button class="rail-btn relative" :title="t('party')">
      <Users class="w-4 h-4" style="color:#CBD5E1" />
      <span
        class="absolute inline-flex items-center justify-center text-[9px] font-black px-[3px] rounded"
        style="top:6px;right:2px;min-width:14px;height:12px;background:#22D3EE;color:#0A0F1C"
      >3</span>
    </button>

    <div class="w-[38px] h-px" style="background:#1E293B" />

    <!-- Messages (placeholder) -->
    <button class="rail-btn relative" :title="t('messages')">
      <MessageSquare class="w-4 h-4" style="color:#CBD5E1" />
      <span
        class="absolute inline-flex items-center justify-center text-[9px] font-black px-[3px] rounded text-white"
        style="top:6px;right:2px;min-width:14px;height:12px;background:#EF4444"
      >1</span>
    </button>

    <!-- Plus (placeholder) -->
    <button class="rail-btn" :title="t('create')">
      <Plus class="w-4 h-4" style="color:#22D3EE" />
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

    <!-- Spacer -->
    <div class="flex-1 min-h-[20px]" />

    <!-- Voice (placeholder) -->
    <button
      class="w-[38px] h-[38px] rounded-lg flex items-center justify-center"
      style="background:#22D3EE"
      :title="t('voiceChat')"
    >
      <Headphones class="w-4 h-4" style="color:#0A0F1C" />
    </button>
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
