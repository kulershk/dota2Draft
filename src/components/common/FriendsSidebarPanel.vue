<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { Users, UserPlus, X, Search, MessageCircle } from 'lucide-vue-next'
import { useFriendStore, type FriendEntry } from '@/composables/useFriendStore'
import { useMessageStore } from '@/composables/useMessageStore'
import { useSidePanels } from '@/composables/useSidePanels'

const { t } = useI18n()
const router = useRouter()
const friendStore = useFriendStore()
const messageStore = useMessageStore()
const panels = useSidePanels()

const FRIEND_GRADIENTS = [
  ['#F59E0B', '#EF4444'],
  ['#22D3EE', '#0891B2'],
  ['#A78BFA', '#0F172A'],
  ['#22C55E', '#0F172A'],
  ['#EF4444', '#0F172A'],
  ['#FACC15', '#0F172A'],
  ['#0891B2', '#0F172A'],
  ['#EC4899', '#F59E0B'],
] as const

function gradientFor(playerId: number): string {
  const [a, b] = FRIEND_GRADIENTS[playerId % FRIEND_GRADIENTS.length]
  return `linear-gradient(135deg,${a},${b})`
}
function initialFor(f: FriendEntry): string {
  const n = f.player.display_name || f.player.name || '?'
  return n.charAt(0).toUpperCase()
}

const searchQuery = ref('')
watch(() => panels.active.value, (a) => {
  if (a !== 'friends') searchQuery.value = ''
})

function matches(f: FriendEntry): boolean {
  if (!searchQuery.value.trim()) return true
  const q = searchQuery.value.trim().toLowerCase()
  return (f.player.display_name || f.player.name || '').toLowerCase().includes(q)
}

const onlineFriends = computed(() => friendStore.friends.value.filter(f => f.online && matches(f)))
const offlineFriends = computed(() => friendStore.friends.value.filter(f => !f.online && matches(f)))

function goToProfile(friend: FriendEntry) {
  router.push({ name: 'player-profile', params: { id: friend.player.id } })
  panels.close()
}

function openChatWith(friend: FriendEntry) {
  messageStore.openThread({
    id: friend.player.id,
    name: friend.player.name,
    display_name: friend.player.display_name,
    steam_name: friend.player.steam_name,
    avatar_url: friend.player.avatar_url,
    mmr: friend.player.mmr,
  })
  panels.openChats()
}

function goToAddFriend() {
  router.push('/friends')
  panels.close()
}
</script>

<template>
  <Teleport to="body">
    <Transition name="slide-right">
      <aside
        v-if="panels.active.value === 'friends'"
        class="fixed top-0 bottom-0 w-[320px] z-50 flex flex-col shadow-[0_0_60px_0_rgba(0,0,0,0.8)] md:right-[70px] right-0"
        style="background:#0F172A;border-left:1px solid #22D3EE;border-right:1px solid #1E293B"
      >
        <!-- Header -->
        <div
          class="flex items-center justify-between h-[54px] px-[18px] shrink-0"
          style="background:#0A0F1C;border-bottom:1px solid #1E293B"
        >
          <div class="flex items-center gap-2">
            <Users class="w-[15px] h-[15px]" style="color:#22D3EE" />
            <span class="text-[15px] font-extrabold" style="color:#F1F5F9">
              {{ t('friends') }} <span style="color:#475569">({{ friendStore.friends.value.length }})</span>
            </span>
          </div>
          <div class="flex items-center gap-1.5">
            <button
              class="w-[26px] h-[26px] rounded-md flex items-center justify-center transition-colors hover:bg-white/5"
              style="box-shadow:inset 0 0 0 1px #1E293B"
              :title="t('addFriend')"
              @click="goToAddFriend"
            >
              <UserPlus class="w-[13px] h-[13px]" style="color:#22D3EE" />
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

        <!-- Search -->
        <div class="px-[18px] py-2.5 shrink-0" style="border-bottom:1px solid #1E293B">
          <div
            class="flex items-center gap-2 rounded-lg px-3 py-2"
            style="background:#0A0F1C;box-shadow:inset 0 0 0 1px #1E293B"
          >
            <Search class="w-[13px] h-[13px] shrink-0" style="color:#475569" />
            <input
              v-model="searchQuery"
              type="text"
              :placeholder="t('search')"
              class="flex-1 bg-transparent outline-none text-[12px] min-w-0"
              style="color:#F1F5F9"
            />
          </div>
        </div>

        <!-- Body -->
        <div class="flex-1 overflow-y-auto">
          <div v-if="onlineFriends.length" class="px-[10px] pt-[10px] pb-2 flex flex-col gap-0.5">
            <div class="flex items-center gap-1.5 px-2 py-1">
              <span class="w-2 h-2 rounded-full" style="background:#22D3EE" />
              <span class="text-[10px] font-extrabold tracking-[1.2px]" style="color:#22D3EE">
                ONLINE — {{ onlineFriends.length }}
              </span>
            </div>
            <div
              v-for="f in onlineFriends"
              :key="f.id"
              class="flex items-center gap-2.5 rounded-md p-2 transition-colors hover:bg-white/5"
            >
              <button class="flex items-center gap-2.5 flex-1 min-w-0 text-left" @click="goToProfile(f)">
                <div class="relative w-9 h-9 shrink-0">
                  <div
                    class="w-9 h-9 rounded-full flex items-center justify-center"
                    :style="{ background: gradientFor(f.player.id) }"
                  >
                    <img v-if="f.player.avatar_url" :src="f.player.avatar_url" class="w-full h-full rounded-full object-cover" />
                    <span v-else class="text-white text-[15px] font-extrabold">{{ initialFor(f) }}</span>
                  </div>
                  <span
                    class="absolute right-[-2px] bottom-[-2px] w-[10px] h-[10px] rounded-full"
                    style="background:#22D3EE;box-shadow:inset 0 0 0 2px #0F172A"
                  />
                </div>
                <div class="flex-1 min-w-0">
                  <div class="text-[13px] font-bold truncate" style="color:#F1F5F9">
                    {{ f.player.display_name || f.player.name }}
                  </div>
                  <div class="text-[11px] truncate" style="color:#64748B">{{ t('online') }}</div>
                </div>
              </button>
              <button
                class="w-7 h-7 rounded-md flex items-center justify-center shrink-0 transition-colors hover:bg-white/10"
                style="background:#1E293B;box-shadow:inset 0 0 0 1px #1E293B"
                :title="t('messages')"
                @click="openChatWith(f)"
              >
                <MessageCircle class="w-[13px] h-[13px]" style="color:#94A3B8" />
              </button>
            </div>
          </div>

          <div v-if="offlineFriends.length" class="px-[10px] pt-2 pb-3 flex flex-col gap-0.5">
            <div class="flex items-center gap-1.5 px-2 py-1">
              <span class="w-2 h-2 rounded-full" style="background:#475569" />
              <span class="text-[10px] font-extrabold tracking-[1.2px]" style="color:#475569">
                OFFLINE — {{ offlineFriends.length }}
              </span>
            </div>
            <div
              v-for="f in offlineFriends"
              :key="f.id"
              class="flex items-center gap-2.5 rounded-md p-2 transition-colors hover:bg-white/5"
            >
              <button class="flex items-center gap-2.5 flex-1 min-w-0 text-left" @click="goToProfile(f)">
                <div class="relative w-9 h-9 shrink-0">
                  <div
                    class="w-9 h-9 rounded-full flex items-center justify-center"
                    :style="{ background: gradientFor(f.player.id), opacity: 0.55 }"
                  >
                    <img v-if="f.player.avatar_url" :src="f.player.avatar_url" class="w-full h-full rounded-full object-cover" />
                    <span v-else class="text-white text-[15px] font-extrabold" style="opacity:0.7">{{ initialFor(f) }}</span>
                  </div>
                  <span
                    class="absolute right-[-2px] bottom-[-2px] w-[10px] h-[10px] rounded-full"
                    style="background:#475569;box-shadow:inset 0 0 0 2px #0F172A"
                  />
                </div>
                <div class="flex-1 min-w-0">
                  <div class="text-[13px] font-bold truncate" style="color:#94A3B8">
                    {{ f.player.display_name || f.player.name }}
                  </div>
                  <div class="text-[11px] truncate" style="color:#475569">{{ t('offline') }}</div>
                </div>
              </button>
              <button
                class="w-7 h-7 rounded-md flex items-center justify-center shrink-0 transition-colors hover:bg-white/10"
                style="background:#1E293B;box-shadow:inset 0 0 0 1px #1E293B"
                :title="t('messages')"
                @click="openChatWith(f)"
              >
                <MessageCircle class="w-[13px] h-[13px]" style="color:#475569" />
              </button>
            </div>
          </div>

          <div
            v-if="!onlineFriends.length && !offlineFriends.length"
            class="px-6 py-12 text-center text-[12px]"
            style="color:#475569"
          >
            {{ searchQuery ? t('noMatchingFriends') : t('noFriendsYet') }}
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
