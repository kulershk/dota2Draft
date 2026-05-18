<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { Users, UserPlus, X, Search, MessageCircle, Check, Ban, ShieldOff, Loader2 } from 'lucide-vue-next'
import { useApi } from '@/composables/useApi'
import { useFriendStore, type FriendEntry } from '@/composables/useFriendStore'
import { useMessageStore } from '@/composables/useMessageStore'
import { useDraftStore } from '@/composables/useDraftStore'
import { useSidePanels } from '@/composables/useSidePanels'

const { t } = useI18n()
const router = useRouter()
const api = useApi()
const friendStore = useFriendStore()
const messageStore = useMessageStore()
const draftStore = useDraftStore()
const panels = useSidePanels()

type Tab = 'friends' | 'requests' | 'blocked' | 'add'
const activeTab = ref<Tab>('friends')
const searchQuery = ref('')
const searchResults = ref<any[]>([])
const searching = ref(false)
let searchTimer: ReturnType<typeof setTimeout> | null = null

// Reset search when panel closes or tab changes so each view starts fresh.
watch(() => panels.active.value, (a) => {
  if (a !== 'friends') {
    searchQuery.value = ''
    searchResults.value = []
    activeTab.value = 'friends'
  }
})
watch(activeTab, () => {
  searchQuery.value = ''
  searchResults.value = []
})

// `Add` tab hits the player-search endpoint with debounce; other tabs use the
// query as a local filter against already-loaded data.
watch(searchQuery, (v) => {
  if (activeTab.value !== 'add') return
  if (searchTimer) clearTimeout(searchTimer)
  if (!v || v.trim().length < 2) {
    searchResults.value = []
    return
  }
  searchTimer = setTimeout(async () => {
    searching.value = true
    try {
      searchResults.value = await api.searchPlayers(v.trim())
    } catch {
      searchResults.value = []
    } finally {
      searching.value = false
    }
  }, 250)
})

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
function initialFor(name: string | null | undefined): string {
  return (name || '?').charAt(0).toUpperCase()
}

function nameMatches(name: string | null | undefined): boolean {
  if (!searchQuery.value.trim()) return true
  const q = searchQuery.value.trim().toLowerCase()
  return (name || '').toLowerCase().includes(q)
}

const onlineFriends = computed(() => friendStore.friends.value.filter(f => f.online && nameMatches(f.player.display_name || f.player.name)))
const offlineFriends = computed(() => friendStore.friends.value.filter(f => !f.online && nameMatches(f.player.display_name || f.player.name)))
const incomingFiltered = computed(() => friendStore.incoming.value.filter(f => nameMatches(f.player.display_name || f.player.name)))
const outgoingFiltered = computed(() => friendStore.outgoing.value.filter(f => nameMatches(f.player.display_name || f.player.name)))
const blockedFiltered = computed(() => friendStore.blocks.value.filter(f => nameMatches(f.player.display_name || f.player.name)))

const friendIds = computed(() => new Set(friendStore.friends.value.map(f => f.player.id)))
const outgoingIds = computed(() => new Set(friendStore.outgoing.value.map(f => f.player.id)))
const incomingIds = computed(() => new Set(friendStore.incoming.value.map(f => f.player.id)))
const blockedIds = computed(() => new Set(friendStore.blocks.value.map(f => f.player.id)))

function relationStatus(playerId: number): 'self' | 'friend' | 'outgoing' | 'incoming' | 'blocked' | null {
  if (draftStore.currentUser.value?.id === playerId) return 'self'
  if (friendIds.value.has(playerId)) return 'friend'
  if (outgoingIds.value.has(playerId)) return 'outgoing'
  if (incomingIds.value.has(playerId)) return 'incoming'
  if (blockedIds.value.has(playerId)) return 'blocked'
  return null
}

function goToProfile(playerId: number) {
  router.push({ name: 'player-profile', params: { id: playerId } })
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

async function sendRequest(playerId: number) {
  await api.sendFriendRequest(playerId)
  await friendStore.loadAll()
}
async function acceptRequest(id: number) {
  await api.acceptFriendRequest(id)
  await friendStore.loadAll()
}
async function removeFriendship(id: number) {
  await api.removeFriendship(id)
  await friendStore.loadAll()
}
async function block(playerId: number) {
  await api.blockUser(playerId)
  await friendStore.loadAll()
}
async function unblock(id: number) {
  await api.unblockUser(id)
  await friendStore.loadAll()
}

function searchPlaceholder(): string {
  if (activeTab.value === 'add') return t('searchPlayers')
  return t('search')
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
          <button
            class="w-[26px] h-[26px] rounded-md flex items-center justify-center transition-colors hover:opacity-80"
            style="background:#1E293B"
            :title="t('close')"
            @click="panels.close()"
          >
            <X class="w-[13px] h-[13px]" style="color:#94A3B8" />
          </button>
        </div>

        <!-- Tabs -->
        <div class="grid grid-cols-4 shrink-0" style="background:#0A0F1C;border-bottom:1px solid #1E293B">
          <button
            v-for="tab in (['friends','requests','blocked','add'] as Tab[])" :key="tab"
            class="flex items-center justify-center gap-1 h-[36px] text-[11px] font-extrabold tracking-[0.6px] uppercase transition-colors relative"
            :style="{
              color: activeTab === tab ? '#22D3EE' : '#64748B',
              borderBottom: activeTab === tab ? '2px solid #22D3EE' : '2px solid transparent',
            }"
            @click="activeTab = tab"
          >
            <template v-if="tab === 'friends'">{{ t('friends') }}</template>
            <template v-else-if="tab === 'requests'">
              {{ t('requests') }}
              <span v-if="friendStore.incoming.value.length > 0"
                    class="inline-flex items-center justify-center min-w-[16px] h-[16px] rounded-full px-1 text-[9px] font-extrabold"
                    style="background:#EF4444;color:#fff">
                {{ friendStore.incoming.value.length }}
              </span>
            </template>
            <template v-else-if="tab === 'blocked'">{{ t('blocked') }}</template>
            <template v-else>
              <UserPlus class="w-[12px] h-[12px]" />
              {{ t('addFriend') }}
            </template>
          </button>
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
              :placeholder="searchPlaceholder()"
              class="flex-1 bg-transparent outline-none text-[12px] min-w-0"
              style="color:#F1F5F9"
            />
            <Loader2 v-if="activeTab === 'add' && searching" class="w-[13px] h-[13px] animate-spin shrink-0" style="color:#475569" />
          </div>
        </div>

        <!-- Body -->
        <div class="flex-1 overflow-y-auto">
          <!-- ─── FRIENDS TAB ─── -->
          <template v-if="activeTab === 'friends'">
            <div v-if="onlineFriends.length" class="px-[10px] pt-[10px] pb-2 flex flex-col gap-0.5">
              <div class="flex items-center gap-1.5 px-2 py-1">
                <span class="w-2 h-2 rounded-full" style="background:#22D3EE" />
                <span class="text-[10px] font-extrabold tracking-[1.2px]" style="color:#22D3EE">
                  ONLINE — {{ onlineFriends.length }}
                </span>
              </div>
              <div
                v-for="f in onlineFriends" :key="f.id"
                class="flex items-center gap-2.5 rounded-md p-2 transition-colors hover:bg-white/5"
              >
                <button class="flex items-center gap-2.5 flex-1 min-w-0 text-left" @click="goToProfile(f.player.id)">
                  <div class="relative w-9 h-9 shrink-0">
                    <div
                      class="w-9 h-9 rounded-full flex items-center justify-center"
                      :style="{ background: gradientFor(f.player.id) }"
                    >
                      <img v-if="f.player.avatar_url" :src="f.player.avatar_url" class="w-full h-full rounded-full object-cover" />
                      <span v-else class="text-white text-[15px] font-extrabold">{{ initialFor(f.player.display_name || f.player.name) }}</span>
                    </div>
                    <span
                      class="absolute right-[-2px] bottom-[-2px] w-[10px] h-[10px] rounded-full"
                      style="background:#22D3EE;box-shadow:inset 0 0 0 2px #0F172A"
                    />
                  </div>
                  <div class="flex-1 min-w-0">
                    <div class="text-[13px] font-bold truncate" style="color:#F1F5F9">{{ f.player.display_name || f.player.name }}</div>
                    <div class="text-[11px] truncate" style="color:#64748B">{{ t('online') }}</div>
                  </div>
                </button>
                <button
                  class="w-7 h-7 rounded-md flex items-center justify-center shrink-0 transition-colors hover:bg-white/10"
                  style="background:#1E293B"
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
                v-for="f in offlineFriends" :key="f.id"
                class="flex items-center gap-2.5 rounded-md p-2 transition-colors hover:bg-white/5"
              >
                <button class="flex items-center gap-2.5 flex-1 min-w-0 text-left" @click="goToProfile(f.player.id)">
                  <div class="relative w-9 h-9 shrink-0">
                    <div
                      class="w-9 h-9 rounded-full flex items-center justify-center"
                      :style="{ background: gradientFor(f.player.id), opacity: 0.55 }"
                    >
                      <img v-if="f.player.avatar_url" :src="f.player.avatar_url" class="w-full h-full rounded-full object-cover" />
                      <span v-else class="text-white text-[15px] font-extrabold" style="opacity:0.7">{{ initialFor(f.player.display_name || f.player.name) }}</span>
                    </div>
                    <span
                      class="absolute right-[-2px] bottom-[-2px] w-[10px] h-[10px] rounded-full"
                      style="background:#475569;box-shadow:inset 0 0 0 2px #0F172A"
                    />
                  </div>
                  <div class="flex-1 min-w-0">
                    <div class="text-[13px] font-bold truncate" style="color:#94A3B8">{{ f.player.display_name || f.player.name }}</div>
                    <div class="text-[11px] truncate" style="color:#475569">{{ t('offline') }}</div>
                  </div>
                </button>
                <button
                  class="w-7 h-7 rounded-md flex items-center justify-center shrink-0 transition-colors hover:bg-white/10"
                  style="background:#1E293B"
                  :title="t('messages')"
                  @click="openChatWith(f)"
                >
                  <MessageCircle class="w-[13px] h-[13px]" style="color:#475569" />
                </button>
              </div>
            </div>

            <div v-if="!onlineFriends.length && !offlineFriends.length" class="px-6 py-12 text-center text-[12px]" style="color:#475569">
              {{ searchQuery ? t('noMatchingFriends') : t('noFriendsYet') }}
            </div>
          </template>

          <!-- ─── REQUESTS TAB ─── -->
          <template v-else-if="activeTab === 'requests'">
            <div v-if="incomingFiltered.length" class="px-[10px] pt-[10px] pb-2 flex flex-col gap-0.5">
              <div class="flex items-center gap-1.5 px-2 py-1">
                <span class="text-[10px] font-extrabold tracking-[1.2px]" style="color:#FACC15">
                  {{ t('incomingRequests').toUpperCase() }} — {{ incomingFiltered.length }}
                </span>
              </div>
              <div
                v-for="r in incomingFiltered" :key="r.id"
                class="flex items-center gap-2 rounded-md p-2 transition-colors hover:bg-white/5"
              >
                <button class="flex items-center gap-2.5 flex-1 min-w-0 text-left" @click="goToProfile(r.player.id)">
                  <div class="w-9 h-9 rounded-full flex items-center justify-center shrink-0" :style="{ background: gradientFor(r.player.id) }">
                    <img v-if="r.player.avatar_url" :src="r.player.avatar_url" class="w-full h-full rounded-full object-cover" />
                    <span v-else class="text-white text-[15px] font-extrabold">{{ initialFor(r.player.display_name || r.player.name) }}</span>
                  </div>
                  <div class="flex-1 min-w-0">
                    <div class="text-[13px] font-bold truncate" style="color:#F1F5F9">{{ r.player.display_name || r.player.name }}</div>
                    <div class="text-[11px] truncate" style="color:#64748B">{{ r.player.mmr }} MMR</div>
                  </div>
                </button>
                <button
                  class="w-7 h-7 rounded-md flex items-center justify-center shrink-0 transition-colors hover:brightness-110"
                  style="background:#0891B2"
                  :title="t('acceptRequest')"
                  @click="acceptRequest(r.id)"
                >
                  <Check class="w-[13px] h-[13px]" style="color:#fff" />
                </button>
                <button
                  class="w-7 h-7 rounded-md flex items-center justify-center shrink-0 transition-colors hover:bg-white/10"
                  style="background:#1E293B"
                  :title="t('rejectRequest')"
                  @click="removeFriendship(r.id)"
                >
                  <X class="w-[13px] h-[13px]" style="color:#94A3B8" />
                </button>
              </div>
            </div>

            <div v-if="outgoingFiltered.length" class="px-[10px] pt-2 pb-3 flex flex-col gap-0.5">
              <div class="flex items-center gap-1.5 px-2 py-1">
                <span class="text-[10px] font-extrabold tracking-[1.2px]" style="color:#475569">
                  {{ t('outgoingRequests').toUpperCase() }} — {{ outgoingFiltered.length }}
                </span>
              </div>
              <div
                v-for="r in outgoingFiltered" :key="r.id"
                class="flex items-center gap-2 rounded-md p-2 transition-colors hover:bg-white/5"
              >
                <button class="flex items-center gap-2.5 flex-1 min-w-0 text-left" @click="goToProfile(r.player.id)">
                  <div class="w-9 h-9 rounded-full flex items-center justify-center shrink-0" :style="{ background: gradientFor(r.player.id), opacity: 0.7 }">
                    <img v-if="r.player.avatar_url" :src="r.player.avatar_url" class="w-full h-full rounded-full object-cover" />
                    <span v-else class="text-white text-[15px] font-extrabold">{{ initialFor(r.player.display_name || r.player.name) }}</span>
                  </div>
                  <div class="flex-1 min-w-0">
                    <div class="text-[13px] font-bold truncate" style="color:#CBD5E1">{{ r.player.display_name || r.player.name }}</div>
                    <div class="text-[11px] truncate" style="color:#475569">{{ t('friendRequestSent') }}</div>
                  </div>
                </button>
                <button
                  class="w-7 h-7 rounded-md flex items-center justify-center shrink-0 transition-colors hover:bg-white/10"
                  style="background:#1E293B"
                  :title="t('cancelRequest')"
                  @click="removeFriendship(r.id)"
                >
                  <X class="w-[13px] h-[13px]" style="color:#94A3B8" />
                </button>
              </div>
            </div>

            <div v-if="!incomingFiltered.length && !outgoingFiltered.length" class="px-6 py-12 text-center text-[12px]" style="color:#475569">
              {{ searchQuery ? t('noMatchingFriends') : t('noIncomingRequests') }}
            </div>
          </template>

          <!-- ─── BLOCKED TAB ─── -->
          <template v-else-if="activeTab === 'blocked'">
            <div v-if="blockedFiltered.length" class="px-[10px] pt-[10px] pb-3 flex flex-col gap-0.5">
              <div
                v-for="b in blockedFiltered" :key="b.id"
                class="flex items-center gap-2 rounded-md p-2 transition-colors hover:bg-white/5"
              >
                <div class="w-9 h-9 rounded-full flex items-center justify-center shrink-0" :style="{ background: gradientFor(b.player.id), opacity: 0.45 }">
                  <img v-if="b.player.avatar_url" :src="b.player.avatar_url" class="w-full h-full rounded-full object-cover" />
                  <span v-else class="text-white text-[15px] font-extrabold" style="opacity:0.7">{{ initialFor(b.player.display_name || b.player.name) }}</span>
                </div>
                <div class="flex-1 min-w-0">
                  <div class="text-[13px] font-bold truncate" style="color:#94A3B8">{{ b.player.display_name || b.player.name }}</div>
                  <div class="text-[11px] truncate" style="color:#475569">{{ t('blocked') }}</div>
                </div>
                <button
                  class="h-7 px-2.5 rounded-md flex items-center gap-1.5 shrink-0 transition-colors hover:bg-white/10"
                  style="background:#1E293B"
                  :title="t('unblockUser')"
                  @click="unblock(b.id)"
                >
                  <ShieldOff class="w-[12px] h-[12px]" style="color:#94A3B8" />
                  <span class="text-[11px] font-bold" style="color:#94A3B8">{{ t('unblockUser') }}</span>
                </button>
              </div>
            </div>

            <div v-else class="px-6 py-12 text-center text-[12px]" style="color:#475569">
              {{ searchQuery ? t('noMatchingFriends') : t('noBlockedUsers') }}
            </div>
          </template>

          <!-- ─── ADD TAB ─── -->
          <template v-else>
            <div v-if="searchResults.length" class="px-[10px] pt-[10px] pb-3 flex flex-col gap-0.5">
              <div
                v-for="r in searchResults" :key="r.id"
                class="flex items-center gap-2 rounded-md p-2 transition-colors hover:bg-white/5"
              >
                <button class="flex items-center gap-2.5 flex-1 min-w-0 text-left" @click="goToProfile(r.id)">
                  <div class="w-9 h-9 rounded-full flex items-center justify-center shrink-0" :style="{ background: gradientFor(r.id) }">
                    <img v-if="r.avatar_url" :src="r.avatar_url" class="w-full h-full rounded-full object-cover" />
                    <span v-else class="text-white text-[15px] font-extrabold">{{ initialFor(r.display_name || r.name) }}</span>
                  </div>
                  <div class="flex-1 min-w-0">
                    <div class="text-[13px] font-bold truncate" style="color:#F1F5F9">{{ r.display_name || r.name }}</div>
                    <div class="text-[11px] truncate" style="color:#64748B">{{ r.mmr || 0 }} MMR</div>
                  </div>
                </button>
                <template v-if="relationStatus(r.id) === 'self'">
                  <span class="text-[11px] font-semibold px-2" style="color:#475569">{{ t('thatsYou') }}</span>
                </template>
                <template v-else-if="relationStatus(r.id) === 'friend'">
                  <span class="text-[11px] font-semibold px-2" style="color:#22D3EE">{{ t('alreadyFriends') }}</span>
                </template>
                <template v-else-if="relationStatus(r.id) === 'outgoing'">
                  <span class="text-[11px] font-semibold px-2" style="color:#64748B">{{ t('friendRequestSent') }}</span>
                </template>
                <template v-else-if="relationStatus(r.id) === 'incoming'">
                  <span class="text-[11px] font-semibold px-2" style="color:#FACC15">{{ t('respondInRequests') }}</span>
                </template>
                <template v-else-if="relationStatus(r.id) === 'blocked'">
                  <span class="text-[11px] font-semibold px-2" style="color:#EF4444">{{ t('blocked') }}</span>
                </template>
                <button
                  v-else
                  class="h-7 px-2.5 rounded-md flex items-center gap-1.5 shrink-0 transition-colors hover:brightness-110"
                  style="background:#22D3EE"
                  :title="t('sendFriendRequest')"
                  @click="sendRequest(r.id)"
                >
                  <UserPlus class="w-[12px] h-[12px]" style="color:#0A0F1C" />
                  <span class="text-[11px] font-extrabold" style="color:#0A0F1C">{{ t('add') }}</span>
                </button>
              </div>
            </div>

            <div v-else class="px-6 py-12 text-center text-[12px]" style="color:#475569">
              {{ searchQuery.trim().length >= 2 && !searching ? t('noResults') : t('addFriendHint') }}
            </div>
          </template>
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
