<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { Users as UsersIcon, UserPlus, Check, X, Ban, ShieldOff, Search, Loader2 } from 'lucide-vue-next'
import { useApi } from '@/composables/useApi'
import { useFriendStore } from '@/composables/useFriendStore'
import { useDraftStore } from '@/composables/useDraftStore'

const { t } = useI18n()
const api = useApi()
const friendStore = useFriendStore()
const store = useDraftStore()

const query = ref('')
const searchResults = ref<any[]>([])
const searching = ref(false)
let searchTimer: ReturnType<typeof setTimeout> | null = null

const friendIds = computed(() => new Set(friendStore.friends.value.map(f => f.player.id)))
const outgoingIds = computed(() => new Set(friendStore.outgoing.value.map(f => f.player.id)))
const incomingIds = computed(() => new Set(friendStore.incoming.value.map(f => f.player.id)))
const blockedIds = computed(() => new Set(friendStore.blocks.value.map(f => f.player.id)))

function relationStatus(playerId: number): 'self' | 'friend' | 'outgoing' | 'incoming' | 'blocked' | null {
  if (store.currentUser.value?.id === playerId) return 'self'
  if (friendIds.value.has(playerId)) return 'friend'
  if (outgoingIds.value.has(playerId)) return 'outgoing'
  if (incomingIds.value.has(playerId)) return 'incoming'
  if (blockedIds.value.has(playerId)) return 'blocked'
  return null
}

watch(query, (v) => {
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

async function send(playerId: number) {
  await api.sendFriendRequest(playerId)
  await friendStore.loadAll()
}
async function accept(id: number) {
  await api.acceptFriendRequest(id)
  await friendStore.loadAll()
}
async function remove(id: number) {
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

onMounted(() => {
  if (!friendStore.loaded.value) friendStore.loadAll()
})
</script>

<template>
  <div class="p-4 md:p-8 md:px-10 flex flex-col gap-4 md:gap-6 max-w-[var(--admin-content-max,1200px)] w-full">
    <div class="flex items-center justify-between">
      <div>
        <h1 class="text-2xl font-semibold text-foreground">{{ t('friends') }}</h1>
        <p class="text-sm text-muted-foreground mt-1">{{ t('friendsSubtitle') }}</p>
      </div>
    </div>

    <!-- Add friend -->
    <div class="card">
      <div class="flex items-center gap-2 px-4 py-3 border-b border-border">
        <UserPlus class="w-5 h-5 text-foreground" />
        <span class="text-sm font-semibold text-foreground">{{ t('addFriend') }}</span>
      </div>
      <div class="px-4 py-3">
        <div class="relative">
          <Search class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <input
            v-model="query"
            type="text"
            :placeholder="t('searchPlayers')"
            class="input-field w-full pl-9"
          />
          <Loader2 v-if="searching" class="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground animate-spin" />
        </div>
      </div>
      <div v-if="searchResults.length > 0" class="divide-y divide-border">
        <div v-for="r in searchResults" :key="r.id" class="flex items-center gap-3 px-4 py-2.5">
          <img v-if="r.avatar_url" :src="r.avatar_url" class="w-8 h-8 rounded-full object-cover" />
          <div v-else class="w-8 h-8 rounded-full bg-muted flex items-center justify-center text-xs font-semibold text-foreground">
            {{ (r.display_name || r.name || '?').charAt(0).toUpperCase() }}
          </div>
          <div class="flex-1 min-w-0">
            <div class="text-sm font-medium text-foreground truncate">{{ r.display_name || r.name }}</div>
            <div class="text-[11px] text-muted-foreground truncate">{{ r.steam_id || '' }}</div>
          </div>
          <template v-if="relationStatus(r.id) === 'self'">
            <span class="text-xs text-muted-foreground">{{ t('thatsYou') }}</span>
          </template>
          <template v-else-if="relationStatus(r.id) === 'friend'">
            <span class="text-xs text-primary">{{ t('alreadyFriends') }}</span>
          </template>
          <template v-else-if="relationStatus(r.id) === 'outgoing'">
            <span class="text-xs text-muted-foreground">{{ t('friendRequestSent') }}</span>
          </template>
          <template v-else-if="relationStatus(r.id) === 'incoming'">
            <span class="text-xs text-amber-500">{{ t('respondInRequests') }}</span>
          </template>
          <template v-else-if="relationStatus(r.id) === 'blocked'">
            <span class="text-xs text-destructive">{{ t('blocked') }}</span>
          </template>
          <button v-else class="btn-primary text-xs" @click="send(r.id)">
            <UserPlus class="w-3.5 h-3.5" />
            {{ t('sendFriendRequest') }}
          </button>
        </div>
      </div>
    </div>

    <!-- Incoming requests -->
    <div class="card">
      <div class="flex items-center gap-2 px-4 py-3 border-b border-border">
        <span class="text-sm font-semibold text-foreground">{{ t('incomingRequests') }} ({{ friendStore.incoming.value.length }})</span>
      </div>
      <div v-if="friendStore.incoming.value.length === 0" class="px-4 py-6 text-center text-sm text-muted-foreground">{{ t('noIncomingRequests') }}</div>
      <div v-else class="divide-y divide-border">
        <div v-for="r in friendStore.incoming.value" :key="r.id" class="flex items-center gap-3 px-4 py-2.5">
          <img v-if="r.player.avatar_url" :src="r.player.avatar_url" class="w-8 h-8 rounded-full object-cover" />
          <div v-else class="w-8 h-8 rounded-full bg-muted flex items-center justify-center text-xs font-semibold text-foreground">{{ (r.player.display_name || r.player.name || '?').charAt(0).toUpperCase() }}</div>
          <div class="flex-1 min-w-0">
            <div class="text-sm font-medium text-foreground truncate">{{ r.player.display_name || r.player.name }}</div>
          </div>
          <button class="btn-primary text-xs" @click="accept(r.id)">
            <Check class="w-3.5 h-3.5" /> {{ t('acceptRequest') }}
          </button>
          <button class="btn-secondary text-xs" @click="remove(r.id)">
            <X class="w-3.5 h-3.5" /> {{ t('rejectRequest') }}
          </button>
        </div>
      </div>
    </div>

    <!-- Outgoing requests -->
    <div class="card">
      <div class="flex items-center gap-2 px-4 py-3 border-b border-border">
        <span class="text-sm font-semibold text-foreground">{{ t('outgoingRequests') }} ({{ friendStore.outgoing.value.length }})</span>
      </div>
      <div v-if="friendStore.outgoing.value.length === 0" class="px-4 py-6 text-center text-sm text-muted-foreground">{{ t('noOutgoingRequests') }}</div>
      <div v-else class="divide-y divide-border">
        <div v-for="r in friendStore.outgoing.value" :key="r.id" class="flex items-center gap-3 px-4 py-2.5">
          <img v-if="r.player.avatar_url" :src="r.player.avatar_url" class="w-8 h-8 rounded-full object-cover" />
          <div v-else class="w-8 h-8 rounded-full bg-muted flex items-center justify-center text-xs font-semibold text-foreground">{{ (r.player.display_name || r.player.name || '?').charAt(0).toUpperCase() }}</div>
          <div class="flex-1 min-w-0">
            <div class="text-sm font-medium text-foreground truncate">{{ r.player.display_name || r.player.name }}</div>
          </div>
          <button class="btn-secondary text-xs" @click="remove(r.id)">
            <X class="w-3.5 h-3.5" /> {{ t('cancelRequest') }}
          </button>
        </div>
      </div>
    </div>

    <!-- Friends -->
    <div class="card">
      <div class="flex items-center gap-2 px-4 py-3 border-b border-border">
        <UsersIcon class="w-5 h-5 text-foreground" />
        <span class="text-sm font-semibold text-foreground">{{ t('friends') }} ({{ friendStore.friends.value.length }})</span>
      </div>
      <div v-if="friendStore.friends.value.length === 0" class="px-4 py-6 text-center text-sm text-muted-foreground">{{ t('noFriendsYet') }}</div>
      <div v-else class="divide-y divide-border">
        <div v-for="r in friendStore.friends.value" :key="r.id" class="flex items-center gap-3 px-4 py-2.5">
          <div class="relative">
            <img v-if="r.player.avatar_url" :src="r.player.avatar_url" class="w-8 h-8 rounded-full object-cover" />
            <div v-else class="w-8 h-8 rounded-full bg-muted flex items-center justify-center text-xs font-semibold text-foreground">{{ (r.player.display_name || r.player.name || '?').charAt(0).toUpperCase() }}</div>
            <span v-if="r.online" class="absolute right-[-2px] bottom-[-2px] w-[10px] h-[10px] rounded-full" style="background:#22C55E;box-shadow:inset 0 0 0 2px var(--background,#0A0F1C)" />
          </div>
          <router-link :to="{ name: 'player-profile', params: { id: r.player.id } }" class="flex-1 min-w-0">
            <div class="text-sm font-medium text-foreground truncate hover:text-primary transition-colors">{{ r.player.display_name || r.player.name }}</div>
            <div class="text-[11px] text-muted-foreground truncate">{{ r.player.mmr }} MMR</div>
          </router-link>
          <button class="btn-ghost text-xs" :title="t('removeFriend')" @click="remove(r.id)">
            <X class="w-3.5 h-3.5" />
          </button>
          <button class="btn-ghost text-xs text-destructive" :title="t('blockUser')" @click="block(r.player.id)">
            <Ban class="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </div>

    <!-- Blocked -->
    <div class="card">
      <div class="flex items-center gap-2 px-4 py-3 border-b border-border">
        <Ban class="w-5 h-5 text-foreground" />
        <span class="text-sm font-semibold text-foreground">{{ t('blockedUsers') }} ({{ friendStore.blocks.value.length }})</span>
      </div>
      <div v-if="friendStore.blocks.value.length === 0" class="px-4 py-6 text-center text-sm text-muted-foreground">{{ t('noBlockedUsers') }}</div>
      <div v-else class="divide-y divide-border">
        <div v-for="r in friendStore.blocks.value" :key="r.id" class="flex items-center gap-3 px-4 py-2.5">
          <img v-if="r.player.avatar_url" :src="r.player.avatar_url" class="w-8 h-8 rounded-full object-cover" />
          <div v-else class="w-8 h-8 rounded-full bg-muted flex items-center justify-center text-xs font-semibold text-foreground">{{ (r.player.display_name || r.player.name || '?').charAt(0).toUpperCase() }}</div>
          <div class="flex-1 min-w-0">
            <div class="text-sm font-medium text-foreground truncate">{{ r.player.display_name || r.player.name }}</div>
          </div>
          <button class="btn-secondary text-xs" @click="unblock(r.id)">
            <ShieldOff class="w-3.5 h-3.5" /> {{ t('unblockUser') }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
