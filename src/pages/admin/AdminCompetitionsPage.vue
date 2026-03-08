<script setup lang="ts">
import { Trophy, Plus, Trash2, Pencil, Calendar, User } from 'lucide-vue-next'
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useApi } from '@/composables/useApi'
import { useDraftStore } from '@/composables/useDraftStore'
import ModalOverlay from '@/components/common/ModalOverlay.vue'
import InputGroup from '@/components/common/InputGroup.vue'
import RichTextEditor from '@/components/common/RichTextEditor.vue'

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

function formatDate(dateStr: string) {
  const d = new Date(dateStr)
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
}
</script>

<template>
  <div class="p-4 md:p-8 md:px-10 flex flex-col gap-4 md:gap-6 max-w-[1200px] mx-auto w-full">
    <div class="flex items-center justify-between">
      <div>
        <h1 class="text-2xl font-semibold text-foreground">Competitions</h1>
        <p class="text-sm text-muted-foreground mt-1">Manage draft competitions</p>
      </div>
      <button class="btn-primary text-sm" @click="showCreate = true">
        <Plus class="w-4 h-4" />
        New Competition
      </button>
    </div>

    <div class="card">
      <div class="flex items-center gap-2 px-4 py-3 border-b border-border">
        <Trophy class="w-5 h-5 text-foreground" />
        <span class="text-sm font-semibold text-foreground">All Competitions ({{ store.competitions.value.length }})</span>
      </div>

      <div v-if="store.competitions.value.length === 0" class="px-4 py-12 text-center text-sm text-muted-foreground">
        No competitions yet. Create one to get started.
      </div>

      <div v-else class="divide-y divide-border">
        <div v-for="comp in store.competitions.value" :key="comp.id" class="flex items-center justify-between px-4 py-4 hover:bg-accent/30 transition-colors">
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
                <span class="text-xs text-muted-foreground">Created {{ formatDate(comp.created_at) }}</span>
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
        <h2 class="text-xl font-semibold text-foreground">New Competition</h2>
        <p class="text-sm text-muted-foreground mt-1">Create a new draft competition with its own player pool and settings.</p>
      </div>
      <div class="px-7 py-5 flex flex-col gap-5">
        <InputGroup label="Name" :model-value="newComp.name" placeholder="e.g. Season 1 Draft" @update:model-value="newComp.name = $event" />
        <div class="flex flex-col gap-1.5">
          <label class="label-text">Description (optional)</label>
          <RichTextEditor v-model="newComp.description" />
        </div>
        <div class="flex flex-col gap-1.5">
          <label class="label-text">Registration Start (optional)</label>
          <input type="datetime-local" class="input-field" :value="newComp.registration_start" @input="newComp.registration_start = ($event.target as HTMLInputElement).value" />
        </div>
        <div class="flex flex-col gap-1.5">
          <label class="label-text">Registration End (optional)</label>
          <input type="datetime-local" class="input-field" :value="newComp.registration_end" @input="newComp.registration_end = ($event.target as HTMLInputElement).value" />
        </div>
        <div class="flex flex-col gap-1.5">
          <label class="label-text">Draft Start Date (optional)</label>
          <input type="datetime-local" class="input-field" :value="newComp.starts_at" @input="newComp.starts_at = ($event.target as HTMLInputElement).value" />
        </div>
      </div>
      <div class="px-7 py-5 flex flex-col gap-3 border-t border-border">
        <button class="btn-primary w-full justify-center" :disabled="!newComp.name" @click="createCompetition">
          <Plus class="w-4 h-4" />
          Create Competition
        </button>
        <button class="btn-secondary w-full justify-center" @click="showCreate = false">Cancel</button>
      </div>
    </ModalOverlay>

    <!-- Delete Confirmation -->
    <ModalOverlay :show="showDeleteConfirm !== null" @close="showDeleteConfirm = null">
      <div class="px-7 py-6">
        <h2 class="text-xl font-semibold text-foreground">Delete Competition</h2>
        <p class="text-sm text-muted-foreground mt-2">
          This will permanently delete this competition and all associated data (player pool, captains, auction history). This cannot be undone.
        </p>
      </div>
      <div class="px-7 py-5 flex flex-col gap-3 border-t border-border">
        <button class="btn-destructive w-full justify-center" @click="showDeleteConfirm !== null && deleteCompetition(showDeleteConfirm)">
          <Trash2 class="w-4 h-4" />
          Yes, Delete
        </button>
        <button class="btn-secondary w-full justify-center" @click="showDeleteConfirm = null">Cancel</button>
      </div>
    </ModalOverlay>
  </div>
</template>
