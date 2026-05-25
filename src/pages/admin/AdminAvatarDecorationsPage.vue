<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { Crown, Pencil, Trash2, Plus } from 'lucide-vue-next'
import { useApi } from '@/composables/useApi'
import ModalOverlay from '@/components/common/ModalOverlay.vue'

interface Decoration {
  id: number
  name: string
  category: string | null
  image_url: string
  is_active: boolean
  sort_order: number
  offset_x: number
  offset_y: number
  worn_count: number
}

const { t } = useI18n()
const api = useApi()

const decorations = ref<Decoration[]>([])
const loading = ref(true)

const showModal = ref(false)
const editing = ref<Decoration | null>(null)
const form = ref({ name: '', category: '', sort_order: 0, is_active: true, offset_x: 0, offset_y: 0 })
const imageFile = ref<File | null>(null)
const imagePreview = ref<string | null>(null)
const error = ref('')
const saving = ref(false)

const confirmDelete = ref<Decoration | null>(null)

async function load() {
  loading.value = true
  try {
    decorations.value = await api.adminListAvatarDecorations()
  } finally {
    loading.value = false
  }
}
onMounted(load)

function nextSort(): number {
  if (!decorations.value.length) return 0
  return Math.max(...decorations.value.map(d => d.sort_order)) + 10
}

function openCreate() {
  editing.value = null
  form.value = { name: '', category: '', sort_order: nextSort(), is_active: true, offset_x: 0, offset_y: 0 }
  imageFile.value = null
  imagePreview.value = null
  error.value = ''
  showModal.value = true
}

function openEdit(d: Decoration) {
  editing.value = d
  form.value = { name: d.name, category: d.category || '', sort_order: d.sort_order, is_active: d.is_active, offset_x: d.offset_x || 0, offset_y: d.offset_y || 0 }
  imageFile.value = null
  imagePreview.value = d.image_url
  error.value = ''
  showModal.value = true
}

function onPickImage(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0]
  if (!file) return
  imageFile.value = file
  imagePreview.value = URL.createObjectURL(file)
}

async function save() {
  error.value = ''
  if (!form.value.name.trim()) { error.value = t('avatarDecorationNameRequired'); return }
  if (!editing.value && !imageFile.value) { error.value = t('avatarDecorationImageRequired'); return }
  saving.value = true
  try {
    if (editing.value) {
      await api.updateAvatarDecoration(editing.value.id, {
        name: form.value.name.trim(),
        category: form.value.category.trim() || null,
        is_active: form.value.is_active,
        sort_order: Math.floor(Number(form.value.sort_order) || 0),
        offset_x: Math.round(Number(form.value.offset_x) || 0),
        offset_y: Math.round(Number(form.value.offset_y) || 0),
      })
      if (imageFile.value) await api.uploadAvatarDecorationImage(editing.value.id, imageFile.value)
    } else {
      const fd = new FormData()
      fd.append('image', imageFile.value!)
      fd.append('name', form.value.name.trim())
      if (form.value.category.trim()) fd.append('category', form.value.category.trim())
      fd.append('is_active', String(form.value.is_active))
      fd.append('sort_order', String(Math.floor(Number(form.value.sort_order) || 0)))
      fd.append('offset_x', String(Math.round(Number(form.value.offset_x) || 0)))
      fd.append('offset_y', String(Math.round(Number(form.value.offset_y) || 0)))
      await api.createAvatarDecoration(fd)
    }
    showModal.value = false
    await load()
  } catch (e: any) {
    error.value = e?.message || 'Error'
  } finally {
    saving.value = false
  }
}

async function doDelete() {
  if (!confirmDelete.value) return
  await api.deleteAvatarDecoration(confirmDelete.value.id)
  confirmDelete.value = null
  await load()
}
</script>

<template>
  <div class="p-4 md:p-8 md:px-10 flex flex-col gap-4 md:gap-6 max-w-[var(--admin-content-max,1200px)] w-full">
    <div class="flex items-center justify-between">
      <div>
        <h1 class="text-2xl font-semibold text-foreground">{{ t('avatarDecorationsTitle') }}</h1>
        <p class="text-sm text-muted-foreground mt-1">{{ t('avatarDecorationsSubtitle') }}</p>
      </div>
      <button class="btn-primary text-sm flex items-center gap-1.5" @click="openCreate">
        <Plus class="w-4 h-4" /> {{ t('avatarDecorationAdd') }}
      </button>
    </div>

    <div class="card p-4">
      <div v-if="loading" class="text-center py-10 text-muted-foreground">{{ t('loading') }}</div>
      <div v-else-if="!decorations.length" class="text-center py-10 text-muted-foreground">{{ t('avatarDecorationsEmpty') }}</div>
      <div v-else class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
        <div v-for="d in decorations" :key="d.id"
          class="relative flex flex-col items-center gap-2 p-3 rounded-lg border border-border bg-accent/10"
          :class="{ 'opacity-50': !d.is_active }">
          <!-- preview over a sample avatar circle -->
          <div class="relative w-16 h-16">
            <div class="w-16 h-16 rounded-full bg-gradient-to-br from-primary/30 to-purple-500/30"></div>
            <img :src="d.image_url" :alt="d.name" :style="{ transform: `translate(${d.offset_x || 0}%, ${d.offset_y || 0}%)` }" class="absolute inset-0 w-full h-full object-contain pointer-events-none" />
          </div>
          <div class="text-center min-w-0 w-full">
            <div class="text-sm font-medium text-foreground truncate">{{ d.name }}</div>
            <div v-if="d.category" class="text-[11px] text-muted-foreground truncate">{{ d.category }}</div>
            <div class="text-[11px] text-muted-foreground">{{ t('avatarDecorationWornCount', { n: d.worn_count }) }}</div>
            <div v-if="!d.is_active" class="text-[10px] uppercase tracking-wide text-amber-500 font-bold mt-0.5">{{ t('avatarDecorationInactive') }}</div>
          </div>
          <div class="flex items-center gap-1">
            <button class="p-1.5 rounded-md hover:bg-accent text-muted-foreground hover:text-foreground" :title="t('edit')" @click="openEdit(d)">
              <Pencil class="w-4 h-4" />
            </button>
            <button class="p-1.5 rounded-md hover:bg-red-500/15 text-muted-foreground hover:text-red-500" :title="t('delete')" @click="confirmDelete = d">
              <Trash2 class="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- Create / edit modal -->
    <ModalOverlay :show="showModal" @close="showModal = false">
      <div class="p-5 flex flex-col gap-4 w-[min(92vw,440px)]">
        <h2 class="text-lg font-bold text-foreground">{{ editing ? t('avatarDecorationEdit') : t('avatarDecorationAdd') }}</h2>

        <div class="flex items-center gap-3">
          <!-- Live preview over a sample avatar; reflects the offsets below -->
          <div class="relative w-20 h-20 shrink-0">
            <div class="w-20 h-20 rounded-full bg-gradient-to-br from-primary/30 to-purple-500/30 flex items-center justify-center">
              <Crown v-if="!imagePreview" class="w-6 h-6 text-muted-foreground" />
            </div>
            <img v-if="imagePreview" :src="imagePreview"
              :style="{ transform: `translate(${form.offset_x || 0}%, ${form.offset_y || 0}%)` }"
              class="absolute inset-0 w-full h-full object-contain pointer-events-none" />
          </div>
          <input type="file" accept="image/*"
            class="text-xs file:mr-3 file:py-1.5 file:px-3 file:rounded file:border-0 file:bg-primary file:text-[#0A0F1C] file:font-semibold file:cursor-pointer hover:file:brightness-110"
            @change="onPickImage" />
        </div>

        <div class="grid grid-cols-2 gap-3">
          <label class="flex flex-col gap-1">
            <span class="text-[11px] uppercase tracking-wide text-muted-foreground">{{ t('avatarDecorationOffsetX') }}</span>
            <input v-model.number="form.offset_x" type="range" min="-100" max="100" class="accent-primary" />
            <span class="text-[11px] text-muted-foreground tabular-nums text-center">{{ form.offset_x }}%</span>
          </label>
          <label class="flex flex-col gap-1">
            <span class="text-[11px] uppercase tracking-wide text-muted-foreground">{{ t('avatarDecorationOffsetY') }}</span>
            <input v-model.number="form.offset_y" type="range" min="-100" max="100" class="accent-primary" />
            <span class="text-[11px] text-muted-foreground tabular-nums text-center">{{ form.offset_y }}%</span>
          </label>
        </div>

        <label class="flex flex-col gap-1">
          <span class="text-[11px] uppercase tracking-wide text-muted-foreground">{{ t('avatarDecorationName') }}</span>
          <input v-model="form.name" class="px-3 py-2 rounded border border-border bg-background text-sm" />
        </label>
        <div class="grid grid-cols-2 gap-3">
          <label class="flex flex-col gap-1">
            <span class="text-[11px] uppercase tracking-wide text-muted-foreground">{{ t('avatarDecorationCategory') }}</span>
            <input v-model="form.category" class="px-3 py-2 rounded border border-border bg-background text-sm" placeholder="crown / glasses…" />
          </label>
          <label class="flex flex-col gap-1">
            <span class="text-[11px] uppercase tracking-wide text-muted-foreground">{{ t('avatarDecorationSort') }}</span>
            <input v-model.number="form.sort_order" type="number" class="px-3 py-2 rounded border border-border bg-background text-sm tabular-nums" />
          </label>
        </div>
        <label class="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" class="w-4 h-4 accent-primary" v-model="form.is_active" />
          <span class="text-sm text-foreground">{{ t('avatarDecorationActive') }}</span>
        </label>

        <p v-if="error" class="text-sm text-destructive">{{ error }}</p>
        <div class="flex gap-2">
          <button class="btn-secondary flex-1 justify-center" @click="showModal = false">{{ t('cancel') }}</button>
          <button class="btn-primary flex-1 justify-center disabled:opacity-50" :disabled="saving" @click="save">{{ t('save') }}</button>
        </div>
      </div>
    </ModalOverlay>

    <!-- Delete confirm -->
    <ModalOverlay :show="!!confirmDelete" @close="confirmDelete = null">
      <div class="p-5 flex flex-col gap-4 w-[min(92vw,380px)]">
        <h2 class="text-lg font-bold text-foreground">{{ t('avatarDecorationDeleteTitle') }}</h2>
        <p class="text-sm text-muted-foreground">{{ t('avatarDecorationDeleteConfirm', { name: confirmDelete?.name }) }}</p>
        <div class="flex gap-2">
          <button class="btn-secondary flex-1 justify-center" @click="confirmDelete = null">{{ t('cancel') }}</button>
          <button class="flex-1 justify-center py-2 rounded-lg bg-red-600 text-white font-semibold hover:bg-red-700" @click="doDelete">{{ t('delete') }}</button>
        </div>
      </div>
    </ModalOverlay>
  </div>
</template>
