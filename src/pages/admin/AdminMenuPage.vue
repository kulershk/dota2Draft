<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { Menu as MenuIcon, Plus, Trash2, ArrowUp, ArrowDown, Eye, EyeOff, Save, X } from 'lucide-vue-next'
import { useApi } from '@/composables/useApi'
import { useNavStore } from '@/composables/useNavStore'

interface AdminNavItem {
  id: number
  sort_order: number
  label_key: string | null
  labels: { en?: string; lv?: string; lt?: string } | null
  icon: string
  path: string | null
  is_external: boolean
  is_visible: boolean
  active_match: string | null
  requires_auth: boolean
  badge: string | null
  parent_id: number | null
  column_group: string | null
}

const { t } = useI18n()
const api = useApi()
const navStore = useNavStore()

const items = ref<AdminNavItem[]>([])

// Render order: each root immediately followed by its children. Both roots
// and the children of each root keep their own sort_order.
const orderedItems = computed<AdminNavItem[]>(() => {
  const childrenByParent = new Map<number, AdminNavItem[]>()
  for (const it of items.value) {
    if (it.parent_id) {
      if (!childrenByParent.has(it.parent_id)) childrenByParent.set(it.parent_id, [])
      childrenByParent.get(it.parent_id)!.push(it)
    }
  }
  const out: AdminNavItem[] = []
  for (const it of items.value) {
    if (it.parent_id) continue
    out.push(it)
    const kids = childrenByParent.get(it.id)
    if (kids) for (const k of kids) out.push(k)
  }
  // Append orphans (children whose parent_id no longer exists) at the end so
  // they're still editable rather than vanishing from the list.
  const rootIds = new Set(items.value.filter(i => !i.parent_id).map(i => i.id))
  for (const it of items.value) {
    if (it.parent_id && !rootIds.has(it.parent_id)) out.push(it)
  }
  return out
})
const loading = ref(false)
const editing = ref<AdminNavItem | null>(null)
const showCreate = ref(false)

const ICON_OPTIONS = [
  'Home', 'Swords', 'Calendar', 'Newspaper', 'Trophy', 'Medal',
  'Settings', 'Shield', 'User', 'Radio', 'Star', 'Zap',
  'Activity', 'BarChart3', 'Bot', 'Gamepad2', 'Users', 'Tv',
]

const blank = (): AdminNavItem => ({
  id: 0,
  sort_order: 0,
  label_key: '',
  labels: { en: '', lv: '', lt: '' },
  icon: 'Swords',
  path: '',
  is_external: false,
  is_visible: true,
  active_match: '',
  requires_auth: false,
  badge: null,
  parent_id: null,
  column_group: '',
})

async function load() {
  loading.value = true
  try {
    items.value = await api.getAdminNavItems()
  } finally {
    loading.value = false
  }
}

// Move within siblings (same parent_id). Roots reorder among roots,
// children reorder among children of the same parent.
function siblingsOf(item: AdminNavItem): AdminNavItem[] {
  return items.value.filter(i => (i.parent_id || null) === (item.parent_id || null))
}

async function reorderItem(item: AdminNavItem, direction: -1 | 1) {
  const siblings = siblingsOf(item).slice()
  const idx = siblings.findIndex(s => s.id === item.id)
  const target = idx + direction
  if (target < 0 || target >= siblings.length) return
  ;[siblings[idx], siblings[target]] = [siblings[target], siblings[idx]]

  const rootList = item.parent_id
    ? items.value.filter(i => !i.parent_id)
    : siblings
  const childrenByParent = new Map<number, AdminNavItem[]>()
  for (const it of items.value) {
    if (it.parent_id) {
      if (!childrenByParent.has(it.parent_id)) childrenByParent.set(it.parent_id, [])
      childrenByParent.get(it.parent_id)!.push(it)
    }
  }
  if (item.parent_id) childrenByParent.set(item.parent_id, siblings)

  const allOrder: number[] = []
  for (const root of rootList) {
    allOrder.push(root.id)
    const kids = childrenByParent.get(root.id)
    if (kids) for (const k of kids) allOrder.push(k.id)
  }

  await api.reorderNavItems(allOrder)
  await load()
  await navStore.refresh()
}

async function toggleVisible(item: AdminNavItem) {
  await api.updateNavItem(item.id, { is_visible: !item.is_visible })
  await load()
  await navStore.refresh()
}

async function remove(item: AdminNavItem) {
  if (!confirm(t('navMenuConfirmDelete', { label: item.label_key || item.path }))) return
  await api.deleteNavItem(item.id)
  await load()
  await navStore.refresh()
}

function openEdit(item: AdminNavItem) {
  editing.value = JSON.parse(JSON.stringify(item))
  if (!editing.value!.labels) editing.value!.labels = { en: '', lv: '', lt: '' }
}

function openCreate() {
  editing.value = blank()
  showCreate.value = true
}

async function save() {
  if (!editing.value) return
  const payload = {
    label_key: editing.value.label_key || null,
    labels: (editing.value.labels?.en || editing.value.labels?.lv || editing.value.labels?.lt)
      ? editing.value.labels : null,
    icon: editing.value.icon,
    path: editing.value.path || null,
    is_external: editing.value.is_external,
    is_visible: editing.value.is_visible,
    active_match: editing.value.active_match || null,
    requires_auth: editing.value.requires_auth,
    badge: editing.value.badge || null,
    parent_id: editing.value.parent_id || null,
    column_group: editing.value.column_group || null,
  }
  if (showCreate.value) {
    await api.createNavItem(payload)
  } else {
    await api.updateNavItem(editing.value.id, payload)
  }
  editing.value = null
  showCreate.value = false
  await load()
  await navStore.refresh()
}

function cancel() {
  editing.value = null
  showCreate.value = false
}

onMounted(load)
</script>

<template>
  <div class="p-4 md:p-8 md:px-10 flex flex-col gap-4 md:gap-6 max-w-[var(--admin-content-max,1200px)] w-full">
    <div class="flex items-center justify-between">
      <div>
        <h1 class="text-2xl font-semibold text-foreground">{{ t('adminMenu') }}</h1>
        <p class="text-sm text-muted-foreground mt-1">{{ t('adminMenuDesc') }}</p>
      </div>
      <button class="btn-primary text-sm flex items-center gap-1.5" @click="openCreate">
        <Plus class="w-4 h-4" /> {{ t('navMenuAddItem') }}
      </button>
    </div>

    <div class="card p-0 overflow-hidden">
      <table class="w-full text-sm">
        <thead class="bg-surface text-[11px] font-semibold font-mono uppercase tracking-wider text-text-tertiary">
          <tr>
            <th class="text-left px-4 py-2.5 w-12">#</th>
            <th class="text-left px-4 py-2.5">{{ t('navMenuLabel') }}</th>
            <th class="text-left px-4 py-2.5">{{ t('navMenuIcon') }}</th>
            <th class="text-left px-4 py-2.5">{{ t('navMenuPath') }}</th>
            <th class="text-center px-4 py-2.5 w-20">{{ t('navMenuVisible') }}</th>
            <th class="text-right px-4 py-2.5 w-44">{{ t('actions') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="loading && items.length === 0"><td colspan="6" class="px-4 py-6 text-center text-muted-foreground">{{ t('loading') }}</td></tr>
          <tr v-else-if="items.length === 0"><td colspan="6" class="px-4 py-6 text-center text-muted-foreground">{{ t('navMenuEmpty') }}</td></tr>
          <tr v-for="(item, i) in orderedItems" :key="item.id" class="border-t border-border" :class="[!item.is_visible ? 'opacity-50' : '', item.parent_id ? 'bg-accent/10' : '']">
            <td class="px-4 py-2 text-muted-foreground tabular-nums">{{ i + 1 }}</td>
            <td class="px-4 py-2">
              <div class="text-foreground font-medium" :class="item.parent_id ? 'pl-5 text-sm' : ''">
                <span v-if="item.parent_id" class="text-muted-foreground mr-1">↳</span>
                <template v-if="item.labels?.en || item.labels?.lv || item.labels?.lt">{{ item.labels?.en || item.labels?.lv || item.labels?.lt }}</template>
                <template v-else-if="item.label_key">{{ t(item.label_key) }}</template>
                <template v-else>—</template>
              </div>
              <div class="text-[11px] text-muted-foreground" :class="item.parent_id ? 'pl-5' : ''">
                <span v-if="item.label_key">key: <span class="font-mono">{{ item.label_key }}</span></span>
                <span v-if="item.column_group" class="ml-2 px-1.5 py-0 rounded bg-accent/40 text-[10px] font-mono uppercase">{{ item.column_group }}</span>
              </div>
            </td>
            <td class="px-4 py-2 font-mono text-xs text-muted-foreground">{{ item.icon }}</td>
            <td class="px-4 py-2 font-mono text-xs text-foreground">
              <template v-if="item.path">{{ item.path }}</template>
              <span v-else class="text-muted-foreground italic font-sans">— {{ t('navMenuDropdownOnly') }}</span>
              <span v-if="item.is_external" class="ml-1 text-[10px] uppercase text-muted-foreground">({{ t('navMenuExternal') }})</span>
            </td>
            <td class="px-4 py-2 text-center">
              <button class="p-1 rounded hover:bg-accent" :title="item.is_visible ? t('navMenuHide') : t('navMenuShow')" @click="toggleVisible(item)">
                <Eye v-if="item.is_visible" class="w-4 h-4 text-green-500" />
                <EyeOff v-else class="w-4 h-4 text-muted-foreground" />
              </button>
            </td>
            <td class="px-4 py-2 text-right">
              <div class="flex items-center justify-end gap-1">
                <button class="p-1 rounded hover:bg-accent disabled:opacity-30" :disabled="siblingsOf(item).findIndex(s => s.id === item.id) === 0" :title="t('navMenuMoveUp')" @click="reorderItem(item, -1)">
                  <ArrowUp class="w-3.5 h-3.5" />
                </button>
                <button class="p-1 rounded hover:bg-accent disabled:opacity-30" :disabled="siblingsOf(item).findIndex(s => s.id === item.id) === siblingsOf(item).length - 1" :title="t('navMenuMoveDown')" @click="reorderItem(item, 1)">
                  <ArrowDown class="w-3.5 h-3.5" />
                </button>
                <button class="btn-ghost text-xs px-2" @click="openEdit(item)">{{ t('edit') }}</button>
                <button class="p-1 rounded hover:bg-accent text-red-500" :title="t('delete')" @click="remove(item)">
                  <Trash2 class="w-3.5 h-3.5" />
                </button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Edit / Create Modal -->
    <div v-if="editing" class="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4" @click.self="cancel">
      <div class="bg-card rounded-xl border border-border shadow-2xl w-full max-w-lg flex flex-col">
        <div class="px-6 py-4 border-b border-border flex items-center justify-between">
          <h2 class="text-lg font-semibold text-foreground">
            {{ showCreate ? t('navMenuAddItem') : t('navMenuEditItem') }}
          </h2>
          <button class="p-1 rounded hover:bg-accent" @click="cancel"><X class="w-4 h-4" /></button>
        </div>
        <div class="px-6 py-4 flex flex-col gap-3 max-h-[70vh] overflow-y-auto">
          <div>
            <label class="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{{ t('navMenuLabelKey') }}</label>
            <input v-model="editing.label_key" type="text" class="input-field w-full mt-1" placeholder="e.g. competitions" />
            <p class="text-[11px] text-muted-foreground mt-1">{{ t('navMenuLabelKeyHint') }}</p>
          </div>
          <div class="grid grid-cols-3 gap-2">
            <div>
              <label class="text-xs font-semibold uppercase tracking-wider text-muted-foreground">EN</label>
              <input v-model="editing.labels!.en" type="text" class="input-field w-full mt-1" />
            </div>
            <div>
              <label class="text-xs font-semibold uppercase tracking-wider text-muted-foreground">LV</label>
              <input v-model="editing.labels!.lv" type="text" class="input-field w-full mt-1" />
            </div>
            <div>
              <label class="text-xs font-semibold uppercase tracking-wider text-muted-foreground">LT</label>
              <input v-model="editing.labels!.lt" type="text" class="input-field w-full mt-1" />
            </div>
          </div>
          <p class="text-[11px] text-muted-foreground -mt-2">{{ t('navMenuLabelsHint') }}</p>
          <div>
            <label class="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{{ t('navMenuIcon') }}</label>
            <select v-model="editing.icon" class="input-field w-full mt-1">
              <option v-for="ic in ICON_OPTIONS" :key="ic" :value="ic">{{ ic }}</option>
            </select>
          </div>
          <div>
            <label class="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{{ t('navMenuPath') }}</label>
            <input v-model="editing.path" type="text" class="input-field w-full mt-1" placeholder="/competitions or https://..." />
            <p class="text-[11px] text-muted-foreground mt-1">{{ t('navMenuPathHint') }}</p>
          </div>
          <div>
            <label class="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{{ t('navMenuActiveMatch') }}</label>
            <input v-model="editing.active_match" type="text" class="input-field w-full mt-1 font-mono text-xs" placeholder="^/competitions" />
            <p class="text-[11px] text-muted-foreground mt-1">{{ t('navMenuActiveMatchHint') }}</p>
          </div>
          <div class="grid grid-cols-2 gap-2">
            <div>
              <label class="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{{ t('navMenuParent') }}</label>
              <select v-model="editing.parent_id" class="input-field w-full mt-1">
                <option :value="null">— {{ t('navMenuParentNone') }} —</option>
                <option v-for="p in items.filter(p => !p.parent_id && p.id !== editing!.id)" :key="p.id" :value="p.id">
                  {{ p.labels?.en || p.labels?.lv || p.labels?.lt || (p.label_key ? t(p.label_key) : p.path) }}
                </option>
              </select>
            </div>
            <div>
              <label class="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{{ t('navMenuColumnGroup') }}</label>
              <input v-model="editing.column_group" type="text" class="input-field w-full mt-1" placeholder="BROWSE" />
            </div>
          </div>
          <p class="text-[11px] text-muted-foreground -mt-2">{{ t('navMenuColumnGroupHint') }}</p>
          <div class="flex items-center gap-4 flex-wrap">
            <label class="text-sm flex items-center gap-2 cursor-pointer">
              <input v-model="editing.is_visible" type="checkbox" />
              {{ t('navMenuVisible') }}
            </label>
            <label class="text-sm flex items-center gap-2 cursor-pointer">
              <input v-model="editing.is_external" type="checkbox" />
              {{ t('navMenuExternal') }}
            </label>
            <label class="text-sm flex items-center gap-2 cursor-pointer">
              <input v-model="editing.requires_auth" type="checkbox" />
              {{ t('navMenuRequiresAuth') }}
            </label>
          </div>
        </div>
        <div class="px-6 py-4 border-t border-border flex justify-end gap-2">
          <button class="btn-secondary text-sm" @click="cancel">{{ t('cancel') }}</button>
          <button class="btn-primary text-sm flex items-center gap-1.5" @click="save">
            <Save class="w-4 h-4" /> {{ t('save') }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
