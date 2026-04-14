<script setup lang="ts">
import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Plus, Trash2, ArrowRight, AlertCircle, Play, X } from 'lucide-vue-next'
import { useApi } from '@/composables/useApi'
import { useDraftStore } from '@/composables/useDraftStore'
import ModalOverlay from '@/components/common/ModalOverlay.vue'

const props = defineProps<{
  stage: any
  matches: any[]
  captains: any[]
}>()

const emit = defineEmits<{
  (e: 'refresh'): void
}>()

const { t } = useI18n()
const api = useApi()
const store = useDraftStore()

const isDraft = computed(() => props.stage?.status === 'draft')
const sortedMatches = computed(() => {
  return [...props.matches].sort((a, b) => {
    if ((a.round || 0) !== (b.round || 0)) return (a.round || 0) - (b.round || 0)
    if ((a.match_order || 0) !== (b.match_order || 0)) return (a.match_order || 0) - (b.match_order || 0)
    return a.id - b.id
  })
})

// Fast lookup for captain name
function captainName(id: number | null): string {
  if (id == null) return t('tbd')
  const c = props.captains.find((x: any) => x.id === id)
  return c?.team || `#${id}`
}

// Describe the source of a slot (hard seed, incoming winner, incoming loser)
function slotSource(match: any, slot: 1 | 2): { kind: 'seed' | 'winner' | 'loser' | 'empty'; fromId?: number; team?: string } {
  const captainId = slot === 1 ? match.team1_captain_id : match.team2_captain_id
  if (captainId) return { kind: 'seed', team: captainName(captainId) }
  for (const m of props.matches) {
    if (m.id === match.id) continue
    if (m.next_match_id === match.id && m.next_match_slot === slot) return { kind: 'winner', fromId: m.id }
    if (m.loser_next_match_id === match.id && m.loser_next_match_slot === slot) return { kind: 'loser', fromId: m.id }
  }
  return { kind: 'empty' }
}

// ── Add match ───────────────────────────────────────────────────────────
async function addMatch() {
  try {
    await api.addCustomStageMatch(store.currentCompetitionId.value!, props.stage.id, {
      best_of: props.stage.bestOf || 3,
      round: 1,
      match_order: props.matches.length,
    })
    emit('refresh')
  } catch (e: any) { alert(e.message) }
}

// ── Edit modal ──────────────────────────────────────────────────────────
const editingId = ref<number | null>(null)
const editForm = ref<{
  best_of: number
  round: number
  label: string
  team1_captain_id: number | null
  team2_captain_id: number | null
  next_match_id: number | null
  next_match_slot: number | null
  loser_next_match_id: number | null
  loser_next_match_slot: number | null
}>({
  best_of: 3, round: 1, label: '',
  team1_captain_id: null, team2_captain_id: null,
  next_match_id: null, next_match_slot: null,
  loser_next_match_id: null, loser_next_match_slot: null,
})

const editingMatch = computed(() => props.matches.find((m: any) => m.id === editingId.value) || null)
const editingSlot1 = computed(() => editingMatch.value ? slotSource(editingMatch.value, 1) : null)
const editingSlot2 = computed(() => editingMatch.value ? slotSource(editingMatch.value, 2) : null)

// Other matches in this stage that can be used as link targets
const otherMatches = computed(() => props.matches.filter((m: any) => m.id !== editingId.value))

function openEdit(match: any) {
  editingId.value = match.id
  editForm.value = {
    best_of: match.best_of || 3,
    round: match.round || 1,
    label: match.label || '',
    team1_captain_id: match.team1_captain_id,
    team2_captain_id: match.team2_captain_id,
    next_match_id: match.next_match_id,
    next_match_slot: match.next_match_slot,
    loser_next_match_id: match.loser_next_match_id,
    loser_next_match_slot: match.loser_next_match_slot,
  }
}

function closeEdit() { editingId.value = null }

async function saveMeta() {
  if (!editingMatch.value) return
  try {
    await api.updateMatchMeta(editingMatch.value.id, {
      best_of: Number(editForm.value.best_of),
      round: Number(editForm.value.round),
      label: editForm.value.label || null,
    })
    emit('refresh')
  } catch (e: any) { alert(e.message) }
}

async function saveTeams() {
  if (!editingMatch.value) return
  try {
    await api.updateMatchTeams(editingMatch.value.id, {
      team1_captain_id: editForm.value.team1_captain_id,
      team2_captain_id: editForm.value.team2_captain_id,
    })
    emit('refresh')
  } catch (e: any) { alert(e.message) }
}

async function saveLinks() {
  if (!editingMatch.value) return
  try {
    const body: any = {}
    body.next_match_id = editForm.value.next_match_id
    body.next_match_slot = editForm.value.next_match_id ? Number(editForm.value.next_match_slot) || 1 : null
    body.loser_next_match_id = editForm.value.loser_next_match_id
    body.loser_next_match_slot = editForm.value.loser_next_match_id ? Number(editForm.value.loser_next_match_slot) || 1 : null
    await api.updateMatchLinks(editingMatch.value.id, body)
    emit('refresh')
  } catch (e: any) { alert(e.message) }
}

async function saveAll() {
  // Save in an order that avoids conflicts: clear/change links first (so
  // previously-linked slots become free), then teams, then meta.
  if (!editingMatch.value) return
  try {
    const linksBody: any = {
      next_match_id: editForm.value.next_match_id,
      next_match_slot: editForm.value.next_match_id ? Number(editForm.value.next_match_slot) || 1 : null,
      loser_next_match_id: editForm.value.loser_next_match_id,
      loser_next_match_slot: editForm.value.loser_next_match_id ? Number(editForm.value.loser_next_match_slot) || 1 : null,
    }
    await api.updateMatchLinks(editingMatch.value.id, linksBody)
    await api.updateMatchTeams(editingMatch.value.id, {
      team1_captain_id: editForm.value.team1_captain_id,
      team2_captain_id: editForm.value.team2_captain_id,
    })
    await api.updateMatchMeta(editingMatch.value.id, {
      best_of: Number(editForm.value.best_of),
      round: Number(editForm.value.round),
      label: editForm.value.label || null,
    })
    closeEdit()
    emit('refresh')
  } catch (e: any) { alert(e.message) }
}

async function deleteMatch() {
  if (!editingMatch.value) return
  if (!confirm(t('customBracketDeleteConfirm'))) return
  try {
    await api.deleteCustomMatch(editingMatch.value.id)
    closeEdit()
    emit('refresh')
  } catch (e: any) { alert(e.message) }
}

// ── Activate ────────────────────────────────────────────────────────────
const activationErrors = ref<string[]>([])
async function activate() {
  activationErrors.value = []
  try {
    await api.activateCustomStage(store.currentCompetitionId.value!, props.stage.id)
    emit('refresh')
  } catch (e: any) {
    if (e.errors && Array.isArray(e.errors)) {
      activationErrors.value = e.errors
    } else {
      alert(e.message)
    }
  }
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <!-- Toolbar -->
    <div class="flex items-center justify-between gap-3 flex-wrap">
      <div class="flex items-center gap-2">
        <span v-if="isDraft" class="text-[10px] font-bold text-amber-500 bg-amber-500/10 px-2 py-0.5 rounded uppercase">{{ t('customBracketDraft') }}</span>
        <span v-else class="text-[10px] font-bold text-green-500 bg-green-500/10 px-2 py-0.5 rounded uppercase">{{ t('customBracketActive') }}</span>
      </div>
      <div class="flex items-center gap-2">
        <button v-if="isDraft" class="btn-primary text-sm flex items-center gap-1.5" @click="addMatch">
          <Plus class="w-3.5 h-3.5" /> {{ t('customBracketAddMatch') }}
        </button>
        <button v-if="isDraft" class="btn-primary text-sm flex items-center gap-1.5" @click="activate">
          <Play class="w-3.5 h-3.5" /> {{ t('customBracketActivate') }}
        </button>
      </div>
    </div>

    <!-- Activation errors -->
    <div v-if="activationErrors.length > 0" class="card border-destructive/40 px-4 py-3">
      <div class="flex items-center gap-2 text-destructive text-sm font-semibold mb-2">
        <AlertCircle class="w-4 h-4" /> {{ t('customBracketCannotActivate') }}
      </div>
      <ul class="text-xs text-muted-foreground list-disc pl-6 space-y-0.5">
        <li v-for="e in activationErrors" :key="e">{{ e }}</li>
      </ul>
    </div>

    <!-- Empty -->
    <div v-if="sortedMatches.length === 0" class="card px-6 py-12 text-center">
      <p class="text-muted-foreground text-sm">{{ t('customBracketEmpty') }}</p>
      <button v-if="isDraft" class="btn-primary text-sm mt-4 mx-auto flex items-center gap-1.5" @click="addMatch">
        <Plus class="w-4 h-4" /> {{ t('customBracketAddMatch') }}
      </button>
    </div>

    <!-- Match grid grouped by round -->
    <div v-else class="flex flex-col gap-2">
      <div v-for="match in sortedMatches" :key="match.id"
        class="card px-4 py-3 cursor-pointer transition-colors hover:bg-accent/30"
        @click="isDraft && openEdit(match)">
        <div class="flex items-center gap-3 flex-wrap">
          <!-- ID + label + round + bo -->
          <span class="text-xs font-mono text-muted-foreground">#{{ match.id }}</span>
          <span v-if="match.label" class="text-xs font-semibold text-primary bg-primary/10 px-2 py-0.5 rounded">{{ match.label }}</span>
          <span class="text-[10px] text-muted-foreground uppercase tracking-wider">R{{ match.round || 1 }}</span>
          <span class="text-[10px] text-muted-foreground uppercase tracking-wider">Bo{{ match.best_of }}</span>

          <!-- Slots -->
          <div class="flex items-center gap-2 flex-1">
            <div class="flex-1 min-w-0 px-2 py-1.5 rounded bg-accent/40 text-sm">
              <template v-if="slotSource(match, 1).kind === 'seed'">
                <span class="font-medium">{{ slotSource(match, 1).team }}</span>
              </template>
              <template v-else-if="slotSource(match, 1).kind === 'winner'">
                <span class="text-xs text-muted-foreground">← W #{{ slotSource(match, 1).fromId }}</span>
              </template>
              <template v-else-if="slotSource(match, 1).kind === 'loser'">
                <span class="text-xs text-muted-foreground">← L #{{ slotSource(match, 1).fromId }}</span>
              </template>
              <template v-else>
                <span class="text-xs text-muted-foreground/50 italic">{{ t('customBracketEmptySlot') }}</span>
              </template>
            </div>
            <span class="text-xs text-muted-foreground/50">vs</span>
            <div class="flex-1 min-w-0 px-2 py-1.5 rounded bg-accent/40 text-sm">
              <template v-if="slotSource(match, 2).kind === 'seed'">
                <span class="font-medium">{{ slotSource(match, 2).team }}</span>
              </template>
              <template v-else-if="slotSource(match, 2).kind === 'winner'">
                <span class="text-xs text-muted-foreground">← W #{{ slotSource(match, 2).fromId }}</span>
              </template>
              <template v-else-if="slotSource(match, 2).kind === 'loser'">
                <span class="text-xs text-muted-foreground">← L #{{ slotSource(match, 2).fromId }}</span>
              </template>
              <template v-else>
                <span class="text-xs text-muted-foreground/50 italic">{{ t('customBracketEmptySlot') }}</span>
              </template>
            </div>
          </div>

          <!-- Forward links -->
          <div class="flex items-center gap-2 text-[11px] text-muted-foreground">
            <template v-if="match.next_match_id">
              <ArrowRight class="w-3 h-3" />
              <span>W #{{ match.next_match_id }} s{{ match.next_match_slot }}</span>
            </template>
            <template v-if="match.loser_next_match_id">
              <ArrowRight class="w-3 h-3" />
              <span>L #{{ match.loser_next_match_id }} s{{ match.loser_next_match_slot }}</span>
            </template>
          </div>
        </div>
      </div>
    </div>

    <!-- Edit modal -->
    <ModalOverlay :show="editingId !== null" wide @close="closeEdit">
      <div v-if="editingMatch" class="px-6 py-5">
        <div class="flex items-center gap-3 mb-4">
          <h3 class="text-lg font-bold">{{ t('customBracketEditMatch') }} #{{ editingMatch.id }}</h3>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-2 gap-5">
          <!-- Meta -->
          <div class="flex flex-col gap-3">
            <div>
              <label class="text-[11px] font-semibold uppercase text-muted-foreground">{{ t('customBracketLabel') }}</label>
              <input v-model="editForm.label" type="text" class="input-field mt-1" placeholder="Play-in, Upper Finals…" />
            </div>
            <div class="flex gap-3">
              <div class="flex-1">
                <label class="text-[11px] font-semibold uppercase text-muted-foreground">{{ t('bestOf') }}</label>
                <div class="flex gap-1.5 mt-1">
                  <button v-for="n in [1, 3, 5, 7]" :key="n"
                    class="px-3 py-1.5 rounded text-xs font-semibold border transition-colors"
                    :class="editForm.best_of === n ? 'border-primary text-primary bg-primary/10' : 'border-border text-muted-foreground hover:text-foreground'"
                    @click="editForm.best_of = n">Bo{{ n }}</button>
                </div>
              </div>
              <div class="w-24">
                <label class="text-[11px] font-semibold uppercase text-muted-foreground">{{ t('customBracketRound') }}</label>
                <input v-model.number="editForm.round" type="number" min="1" class="input-field mt-1" />
              </div>
            </div>
          </div>

          <!-- Teams -->
          <div class="flex flex-col gap-3">
            <div>
              <label class="text-[11px] font-semibold uppercase text-muted-foreground">{{ t('customBracketSlot1') }}</label>
              <div v-if="editingSlot1?.kind === 'winner' || editingSlot1?.kind === 'loser'" class="text-xs text-muted-foreground mt-1 px-3 py-2 bg-accent/40 rounded">
                ← {{ editingSlot1.kind === 'winner' ? 'Winner' : 'Loser' }} of #{{ editingSlot1.fromId }}
              </div>
              <select v-else v-model="editForm.team1_captain_id" class="input-field mt-1">
                <option :value="null">— {{ t('tbd') }} —</option>
                <option v-for="c in captains" :key="c.id" :value="c.id">{{ c.team }}</option>
              </select>
            </div>
            <div>
              <label class="text-[11px] font-semibold uppercase text-muted-foreground">{{ t('customBracketSlot2') }}</label>
              <div v-if="editingSlot2?.kind === 'winner' || editingSlot2?.kind === 'loser'" class="text-xs text-muted-foreground mt-1 px-3 py-2 bg-accent/40 rounded">
                ← {{ editingSlot2.kind === 'winner' ? 'Winner' : 'Loser' }} of #{{ editingSlot2.fromId }}
              </div>
              <select v-else v-model="editForm.team2_captain_id" class="input-field mt-1">
                <option :value="null">— {{ t('tbd') }} —</option>
                <option v-for="c in captains" :key="c.id" :value="c.id">{{ c.team }}</option>
              </select>
            </div>
          </div>

          <!-- Winner link -->
          <div class="flex flex-col gap-2">
            <label class="text-[11px] font-semibold uppercase text-muted-foreground">{{ t('customBracketWinnerGoesTo') }}</label>
            <div class="flex gap-2">
              <select v-model="editForm.next_match_id" class="input-field flex-1">
                <option :value="null">— {{ t('customBracketTerminal') }} —</option>
                <option v-for="m in otherMatches" :key="m.id" :value="m.id">#{{ m.id }}{{ m.label ? ' (' + m.label + ')' : '' }}</option>
              </select>
              <select v-model="editForm.next_match_slot" class="input-field w-20" :disabled="!editForm.next_match_id">
                <option :value="1">Slot 1</option>
                <option :value="2">Slot 2</option>
              </select>
            </div>
          </div>

          <!-- Loser link -->
          <div class="flex flex-col gap-2">
            <label class="text-[11px] font-semibold uppercase text-muted-foreground">{{ t('customBracketLoserGoesTo') }}</label>
            <div class="flex gap-2">
              <select v-model="editForm.loser_next_match_id" class="input-field flex-1">
                <option :value="null">— {{ t('customBracketNoLink') }} —</option>
                <option v-for="m in otherMatches" :key="m.id" :value="m.id">#{{ m.id }}{{ m.label ? ' (' + m.label + ')' : '' }}</option>
              </select>
              <select v-model="editForm.loser_next_match_slot" class="input-field w-20" :disabled="!editForm.loser_next_match_id">
                <option :value="1">Slot 1</option>
                <option :value="2">Slot 2</option>
              </select>
            </div>
          </div>
        </div>

        <div class="mt-6 pt-4 border-t border-border/30 flex items-center justify-between">
          <button v-if="isDraft" class="btn-ghost text-xs text-destructive flex items-center gap-1.5" @click="deleteMatch">
            <Trash2 class="w-3.5 h-3.5" /> {{ t('delete') }}
          </button>
          <div class="flex items-center gap-2 ml-auto">
            <button class="btn-outline" @click="closeEdit">{{ t('cancel') }}</button>
            <button class="btn-primary" @click="saveAll">{{ t('save') }}</button>
          </div>
        </div>
      </div>
    </ModalOverlay>
  </div>
</template>
