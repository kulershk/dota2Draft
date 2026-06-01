<script setup lang="ts">
// Modal for filing an inhouse report against a specific player. The reporter
// picks the report type (toxic or grief) inside the modal; grief requires a
// comment, toxic's is optional. Replaces the prior prompt()/alert() flow per
// the CLAUDE.md UI dialogs rule. Parent controls visibility via the `show`
// prop and supplies the target player + queue match id; the dialog owns the
// type choice, comment input, submit state and error display.
import { ref, watch, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { AlertTriangle, Loader2, Check, Paperclip, X, FileVideo, FileImage } from 'lucide-vue-next'
import ModalOverlay from '@/components/common/ModalOverlay.vue'
import { useApi } from '@/composables/useApi'

interface ReportablePlayer {
  id: number
  name: string
  avatarUrl?: string | null
}

const props = defineProps<{
  show: boolean
  player: ReportablePlayer | null
  queueMatchId: number | null
}>()
const emit = defineEmits<{
  close: []
  submitted: []
}>()

const { t } = useI18n()
const api = useApi()

const kind = ref<'toxic' | 'grief'>('toxic')
const comment = ref('')
const submitting = ref(false)
const errorText = ref<string | null>(null)
const successFlash = ref(false)

// Evidence uploads — must match the server's limits (middleware/upload.js).
const MAX_EVIDENCE_FILES = 5
const MAX_EVIDENCE_BYTES = 50 * 1024 * 1024
const ALLOWED_EVIDENCE = /^(image\/(jpeg|png|gif|webp)|video\/(mp4|webm|quicktime))$/
const evidenceFiles = ref<File[]>([])
const fileInput = ref<HTMLInputElement | null>(null)

function humanSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

function onPickFiles(e: Event) {
  const input = e.target as HTMLInputElement
  const picked = Array.from(input.files || [])
  errorText.value = null
  for (const f of picked) {
    if (!ALLOWED_EVIDENCE.test(f.type)) {
      errorText.value = t('inhouseReportEvidenceBadType', { name: f.name }) as string
      continue
    }
    if (f.size > MAX_EVIDENCE_BYTES) {
      errorText.value = t('inhouseReportEvidenceTooBig', { name: f.name }) as string
      continue
    }
    if (evidenceFiles.value.length >= MAX_EVIDENCE_FILES) {
      errorText.value = t('inhouseReportEvidenceTooMany', { n: MAX_EVIDENCE_FILES }) as string
      break
    }
    // Skip exact duplicates (same name + size) so re-picking is harmless.
    if (evidenceFiles.value.some(x => x.name === f.name && x.size === f.size)) continue
    evidenceFiles.value.push(f)
  }
  // Reset the native input so picking the same file again still fires change.
  input.value = ''
}

function removeFile(idx: number) {
  evidenceFiles.value.splice(idx, 1)
}

// Reset every time the dialog opens — never leak state (type, comment, files)
// from a prior report against a different player.
watch(() => props.show, (open) => {
  if (open) {
    kind.value = 'toxic'
    comment.value = ''
    evidenceFiles.value = []
    submitting.value = false
    errorText.value = null
    successFlash.value = false
  }
})

const commentRequired = computed(() => kind.value === 'grief')
const canSubmit = computed(() => {
  if (submitting.value) return false
  if (!props.player || !props.queueMatchId) return false
  if (commentRequired.value && !comment.value.trim()) return false
  return true
})

function selectKind(k: 'toxic' | 'grief') {
  if (submitting.value || successFlash.value) return
  kind.value = k
}

async function submit() {
  if (!canSubmit.value || !props.player || !props.queueMatchId) return
  submitting.value = true
  errorText.value = null
  try {
    if (kind.value === 'toxic') {
      await api.reportToxic({
        queue_match_id: props.queueMatchId,
        reported_player_id: props.player.id,
        comment: comment.value.trim() || undefined,
        evidence: evidenceFiles.value,
      })
    } else {
      await api.reportGrief({
        queue_match_id: props.queueMatchId,
        reported_player_id: props.player.id,
        comment: comment.value.trim(),
        evidence: evidenceFiles.value,
      })
    }
    successFlash.value = true
    emit('submitted')
    // Brief success state, then auto-close so the user isn't stuck
    // staring at a "done" screen.
    setTimeout(() => emit('close'), 900)
  } catch (e: any) {
    errorText.value = e?.message || 'Report failed'
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <ModalOverlay :show="show" @close="emit('close')">
    <div class="px-6 py-5 border-b border-border flex items-start gap-3">
      <div
        class="w-9 h-9 rounded-lg flex items-center justify-center shrink-0"
        :class="kind === 'toxic' ? 'bg-amber-500/15' : 'bg-rose-500/15'"
      >
        <AlertTriangle class="w-5 h-5" :class="kind === 'toxic' ? 'text-amber-400' : 'text-rose-400'" />
      </div>
      <div class="min-w-0">
        <h2 class="text-base font-semibold">{{ t('inhouseReportTitle') }}</h2>
        <p v-if="player" class="text-xs text-muted-foreground mt-0.5">
          {{ t('inhouseReportAgainst', { name: player.name }) }}
        </p>
      </div>
    </div>

    <div class="px-6 py-5 flex flex-col gap-3">
      <!-- Report type selector -->
      <label class="text-xs font-medium text-muted-foreground">{{ t('inhouseReportTypeLabel') }}</label>
      <div class="grid grid-cols-2 gap-2">
        <button
          type="button"
          class="px-3 py-2 rounded-md border text-sm font-medium transition-colors"
          :class="kind === 'toxic'
            ? 'border-amber-500/50 bg-amber-500/10 text-amber-400'
            : 'border-border text-muted-foreground hover:bg-muted/50'"
          :disabled="submitting || successFlash"
          @click="selectKind('toxic')"
        >{{ t('inhouseReportKindToxic') }}</button>
        <button
          type="button"
          class="px-3 py-2 rounded-md border text-sm font-medium transition-colors"
          :class="kind === 'grief'
            ? 'border-rose-500/50 bg-rose-500/10 text-rose-400'
            : 'border-border text-muted-foreground hover:bg-muted/50'"
          :disabled="submitting || successFlash"
          @click="selectKind('grief')"
        >{{ t('inhouseReportKindGrief') }}</button>
      </div>

      <label class="text-xs font-medium text-muted-foreground">
        {{ commentRequired ? t('inhouseReportCommentRequired') : t('inhouseReportCommentOptional') }}
      </label>
      <textarea
        v-model="comment"
        class="input-field w-full min-h-[100px] resize-y"
        :placeholder="kind === 'toxic' ? t('inhouseReportToxicPlaceholder') : t('inhouseReportGriefPlaceholder')"
        :maxlength="500"
        :disabled="submitting || successFlash"
      />
      <p class="text-[11px] text-muted-foreground">
        {{ kind === 'toxic' ? t('inhouseReportToxicHelp') : t('inhouseReportGriefHelp') }}
      </p>

      <!-- Evidence (optional): screenshots / short clips, ≤50MB each -->
      <label class="text-xs font-medium text-muted-foreground">{{ t('inhouseReportEvidenceLabel') }}</label>
      <input
        ref="fileInput"
        type="file"
        class="hidden"
        accept="image/jpeg,image/png,image/gif,image/webp,video/mp4,video/webm,video/quicktime"
        multiple
        @change="onPickFiles"
      />
      <div class="flex flex-col gap-2">
        <ul v-if="evidenceFiles.length" class="flex flex-col gap-1.5">
          <li
            v-for="(f, i) in evidenceFiles"
            :key="`${f.name}-${f.size}-${i}`"
            class="flex items-center gap-2 text-xs bg-muted/50 border border-border rounded-md px-2.5 py-1.5"
          >
            <FileVideo v-if="f.type.startsWith('video/')" class="w-4 h-4 text-muted-foreground shrink-0" />
            <FileImage v-else class="w-4 h-4 text-muted-foreground shrink-0" />
            <span class="truncate flex-1 min-w-0">{{ f.name }}</span>
            <span class="text-muted-foreground/70 font-mono shrink-0">{{ humanSize(f.size) }}</span>
            <button
              type="button"
              class="text-muted-foreground hover:text-destructive shrink-0"
              :disabled="submitting || successFlash"
              @click="removeFile(i)"
            >
              <X class="w-3.5 h-3.5" />
            </button>
          </li>
        </ul>
        <button
          type="button"
          class="btn-outline flex items-center justify-center gap-2 text-sm"
          :disabled="submitting || successFlash || evidenceFiles.length >= MAX_EVIDENCE_FILES"
          @click="fileInput?.click()"
        >
          <Paperclip class="w-3.5 h-3.5" />
          {{ t('inhouseReportEvidenceAdd') }}
        </button>
        <p class="text-[11px] text-muted-foreground">{{ t('inhouseReportEvidenceHelp', { n: MAX_EVIDENCE_FILES }) }}</p>
      </div>

      <div v-if="errorText" class="text-xs text-destructive bg-destructive/10 border border-destructive/30 rounded-md px-3 py-2">
        {{ errorText }}
      </div>
      <div v-if="successFlash" class="text-xs text-green-500 bg-green-500/10 border border-green-500/30 rounded-md px-3 py-2 flex items-center gap-2">
        <Check class="w-4 h-4" />
        {{ t('inhouseReportFiled') }}
      </div>
    </div>

    <div class="px-6 py-4 border-t border-border flex justify-end gap-2">
      <button type="button" class="btn-outline" :disabled="submitting" @click="emit('close')">
        {{ t('cancel') }}
      </button>
      <button
        type="button"
        class="btn-primary flex items-center gap-2"
        :disabled="!canSubmit"
        @click="submit"
      >
        <Loader2 v-if="submitting" class="w-3.5 h-3.5 animate-spin" />
        {{ submitting ? t('saving') : t('inhouseReportSubmit') }}
      </button>
    </div>
  </ModalOverlay>
</template>
