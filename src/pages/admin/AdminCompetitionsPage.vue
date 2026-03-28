<script setup lang="ts">
import { Trophy, Plus, Trash2, Pencil, Calendar, User } from 'lucide-vue-next'
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useApi } from '@/composables/useApi'
import { useDraftStore } from '@/composables/useDraftStore'
import ModalOverlay from '@/components/common/ModalOverlay.vue'
import { fmtDateOnly } from '@/utils/format'
import InputGroup from '@/components/common/InputGroup.vue'
import RichTextEditor from '@/components/common/RichTextEditor.vue'
import DatePicker from '@/components/common/DatePicker.vue'

const { t } = useI18n()
const api = useApi()
const store = useDraftStore()
const router = useRouter()

const showCreate = ref(false)
const showDeleteConfirm = ref<number | null>(null)
const newComp = ref({ name: '', description: '', starts_at: '', registration_start: '', registration_end: '' })

onMounted(() => {
  store.fetchCompetitions()
})

async function createCompetition() {
  if (!newComp.value.name) return
  await api.createCompetition({
    name: newComp.value.name,
    description: newComp.value.description,
    starts_at: newComp.value.starts_at || undefined,
    registration_start: newComp.value.registration_start || undefined,
    registration_end: newComp.value.registration_end || undefined,
  })
  newComp.value = { name: '', description: '', starts_at: '', registration_start: '', registration_end: '' }
  showCreate.value = false
  await store.fetchCompetitions()
}

async function deleteCompetition(id: number) {
  await api.deleteCompetition(id)
  showDeleteConfirm.value = null
  await store.fetchCompetitions()
}

const visibleCompetitions = computed(() => {
  const all = store.competitions.value
  if (store.hasPerm('manage_competitions')) return all
  // manage_own_competitions: only show own
  const userId = store.currentUser.value?.id
  return all.filter(c => c.created_by === userId)
})

function formatDate(dateStr: string) {
  return fmtDateOnly(new Date(dateStr))
}
</script>

<template>
  <div class="p-4 md:p-8 md:px-10 flex flex-col gap-4 md:gap-6 max-w-[1200px] w-full">
    <div class="flex items-center justify-between">
      <div>
        <h1 class="text-2xl font-semibold text-foreground">{{ t('adminCompetitions') }}</h1>
        <p class="text-sm text-muted-foreground mt-1">{{ t('manageCompetitions') }}</p>
      </div>
      <button class="btn-primary text-sm" @click="showCreate = true">
        <Plus class="w-4 h-4" />
        {{ t('newCompetition') }}
      </button>
    </div>

    <div class="card">
      <div class="flex items-center gap-2 px-4 py-3 border-b border-border">
        <Trophy class="w-5 h-5 text-foreground" />
        <span class="text-sm font-semibold text-foreground">{{ t('allCompetitions', { count: visibleCompetitions.length }) }}</span>
      </div>

      <div v-if="visibleCompetitions.length === 0" class="px-4 py-12 text-center text-sm text-muted-foreground">
        {{ t('noCompetitionsCreate') }}
      </div>

      <div v-else class="divide-y divide-border">
        <div v-for="comp in visibleCompetitions" :key="comp.id" class="flex items-center justify-between px-4 py-4 hover:bg-accent/30 transition-colors">
          <div class="flex items-center gap-3 min-w-0">
            <div class="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center flex-shrink-0">
              <Trophy class="w-5 h-5 text-primary" />
            </div>
            <div class="min-w-0">
              <h3 class="text-sm font-semibold text-foreground truncate">{{ comp.name }}</h3>
              <div v-if="comp.description" class="text-xs text-muted-foreground truncate prose prose-sm dark:prose-invert max-w-none [&>*]:m-0" v-html="comp.description"></div>
              <div class="flex items-center gap-3 mt-0.5 flex-wrap">
                <span v-if="comp.starts_at" class="flex items-center gap-1 text-xs text-muted-foreground">
                  <Calendar class="w-3 h-3" />
                  {{ formatDate(comp.starts_at) }}
                </span>
                <span v-if="comp.created_by_name" class="flex items-center gap-1 text-xs text-muted-foreground">
                  <User class="w-3 h-3" />
                  {{ comp.created_by_name }}
                </span>
                <span class="text-xs text-muted-foreground">{{ t('created', { date: formatDate(comp.created_at) }) }}</span>
              </div>
            </div>
          </div>
          <div class="flex items-center gap-1 flex-shrink-0 ml-3">
            <button class="btn-ghost p-2" title="Setup" @click="router.push(`/admin/competitions/${comp.id}`)">
              <Pencil class="w-4 h-4" />
            </button>
            <button class="btn-ghost p-2 text-destructive" title="Delete" @click="showDeleteConfirm = comp.id">
              <Trash2 class="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- Create Modal -->
    <ModalOverlay :show="showCreate" wide @close="showCreate = false">
      <div class="border-b border-border px-7 py-6">
        <h2 class="text-xl font-semibold text-foreground">{{ t('newCompModal.title') }}</h2>
        <p class="text-sm text-muted-foreground mt-1">{{ t('newCompModal.subtitle') }}</p>
      </div>
      <div class="px-7 py-5 flex flex-col gap-5">
        <InputGroup :label="t('newCompModal.name')" :model-value="newComp.name" :placeholder="t('newCompModal.namePlaceholder')" @update:model-value="newComp.name = $event" />
        <div class="flex flex-col gap-1.5">
          <label class="label-text">{{ t('newCompModal.descriptionOptional') }}</label>
          <RichTextEditor v-model="newComp.description" />
        </div>
        <DatePicker
          mode="range"
          show-time
          :start-label="t('newCompModal.regStart')"
          :end-label="t('newCompModal.regEnd')"
          :model-start="newComp.registration_start"
          :model-end="newComp.registration_end"
          @update:model-start="newComp.registration_start = $event"
          @update:model-end="newComp.registration_end = $event"
        />
        <DatePicker
          mode="single"
          show-time
          :label="t('newCompModal.draftStart')"
          :model-value="newComp.starts_at"
          @update:model-value="newComp.starts_at = $event"
        />
      </div>
      <div class="px-7 py-5 flex flex-col gap-3 border-t border-border">
        <button class="btn-primary w-full justify-center" :disabled="!newComp.name" @click="createCompetition">
          <Plus class="w-4 h-4" />
          {{ t('newCompModal.create') }}
        </button>
        <button class="btn-secondary w-full justify-center" @click="showCreate = false">{{ t('cancel') }}</button>
      </div>
    </ModalOverlay>

    <!-- Delete Confirmation -->
    <ModalOverlay :show="showDeleteConfirm !== null" @close="showDeleteConfirm = null">
      <div class="px-7 py-6">
        <h2 class="text-xl font-semibold text-foreground">{{ t('deleteCompModal.title') }}</h2>
        <p class="text-sm text-muted-foreground mt-2">
          {{ t('deleteCompModal.message') }}
        </p>
      </div>
      <div class="px-7 py-5 flex flex-col gap-3 border-t border-border">
        <button class="btn-destructive w-full justify-center" @click="showDeleteConfirm !== null && deleteCompetition(showDeleteConfirm)">
          <Trash2 class="w-4 h-4" />
          {{ t('deleteCompModal.confirm') }}
        </button>
        <button class="btn-secondary w-full justify-center" @click="showDeleteConfirm = null">{{ t('cancel') }}</button>
      </div>
    </ModalOverlay>
  </div>
</template>
