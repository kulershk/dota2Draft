<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Bell, Trash2, Send } from 'lucide-vue-next'
import { useApi } from '@/composables/useApi'
import InputGroup from '@/components/common/InputGroup.vue'
import TextareaGroup from '@/components/common/TextareaGroup.vue'
import { fmtDateTime } from '@/utils/format'

const { t } = useI18n()
const api = useApi()

interface AdminAnnouncement {
  id: number
  type: string
  title: string
  body: string | null
  link: string | null
  created_at: string
  sender: { id: number; name: string } | null
}

const announcements = ref<AdminAnnouncement[]>([])
const loading = ref(false)

const title = ref('')
const body = ref('')
const link = ref('')
const sending = ref(false)
const error = ref('')

const canSubmit = computed(() => title.value.trim().length > 0 && !sending.value)

async function fetchAll() {
  loading.value = true
  try {
    announcements.value = await api.listAdminNotifications()
  } catch {
    announcements.value = []
  } finally {
    loading.value = false
  }
}

async function send() {
  if (!canSubmit.value) return
  sending.value = true
  error.value = ''
  try {
    await api.createAnnouncement({
      title: title.value.trim(),
      body: body.value.trim() || null,
      link: link.value.trim() || null,
    })
    title.value = ''
    body.value = ''
    link.value = ''
    await fetchAll()
  } catch (e: any) {
    error.value = e?.message || 'Failed to send'
  } finally {
    sending.value = false
  }
}

async function remove(id: number) {
  if (!confirm(t('confirmDeleteAnnouncement'))) return
  await api.deleteAnnouncement(id)
  await fetchAll()
}

function formatDate(iso: string) {
  return fmtDateTime(new Date(iso))
}

onMounted(fetchAll)
</script>

<template>
  <div class="p-4 md:p-8 md:px-10 flex flex-col gap-4 md:gap-6 max-w-[var(--admin-content-max,1200px)] w-full">
    <div class="flex items-center justify-between">
      <div>
        <h1 class="text-2xl font-semibold text-foreground">{{ t('announcements') }}</h1>
        <p class="text-sm text-muted-foreground mt-1">{{ t('announcementsSubtitle') }}</p>
      </div>
    </div>

    <!-- Composer -->
    <div class="card">
      <div class="flex items-center gap-2 px-4 py-3 border-b border-border">
        <Bell class="w-5 h-5 text-foreground" />
        <span class="text-sm font-semibold text-foreground">{{ t('newAnnouncement') }}</span>
      </div>
      <div class="px-4 py-4 flex flex-col gap-3">
        <InputGroup :label="t('announcementTitle')" :model-value="title" :placeholder="t('announcementTitlePlaceholder')" @update:model-value="title = $event" />
        <TextareaGroup :label="t('announcementBody')" :model-value="body" :placeholder="t('announcementBodyPlaceholder')" :rows="3" @update:model-value="body = $event" />
        <InputGroup :label="t('announcementLink')" :model-value="link" placeholder="https://" @update:model-value="link = $event" />
        <p v-if="error" class="text-sm text-red-500">{{ error }}</p>
        <div class="flex justify-end">
          <button class="btn-primary text-sm" :disabled="!canSubmit" @click="send">
            <Send class="w-4 h-4" />
            {{ t('sendToEveryone') }}
          </button>
        </div>
      </div>
    </div>

    <!-- List -->
    <div class="card">
      <div class="flex items-center gap-2 px-4 py-3 border-b border-border">
        <span class="text-sm font-semibold text-foreground">{{ t('pastAnnouncements') }} ({{ announcements.length }})</span>
      </div>
      <div v-if="loading" class="px-4 py-12 text-center text-sm text-muted-foreground">{{ t('loading') }}</div>
      <div v-else-if="announcements.length === 0" class="px-4 py-12 text-center text-sm text-muted-foreground">{{ t('noAnnouncementsYet') }}</div>
      <div v-else class="divide-y divide-border">
        <div v-for="a in announcements" :key="a.id" class="flex items-start gap-3 px-4 py-3">
          <div class="flex-1 min-w-0">
            <div class="text-sm font-semibold text-foreground truncate">{{ a.title }}</div>
            <div v-if="a.body" class="text-xs text-muted-foreground mt-1 whitespace-pre-wrap">{{ a.body }}</div>
            <div v-if="a.link" class="text-xs text-primary mt-1 truncate">
              <a :href="a.link" target="_blank" rel="noopener" class="hover:underline">{{ a.link }}</a>
            </div>
            <div class="flex items-center gap-2 mt-1.5">
              <span class="text-[11px] text-muted-foreground">{{ formatDate(a.created_at) }}</span>
              <span v-if="a.sender" class="text-[11px] text-muted-foreground">· {{ a.sender.name }}</span>
            </div>
          </div>
          <button class="btn-ghost p-2 text-destructive shrink-0" :title="t('delete')" @click="remove(a.id)">
            <Trash2 class="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
