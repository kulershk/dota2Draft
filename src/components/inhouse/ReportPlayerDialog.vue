<script setup lang="ts">
// Modal for filing an inhouse toxic or grief report against a specific
// player. Replaces the prior prompt()/alert() flow per the CLAUDE.md UI
// dialogs rule. Parent controls visibility via the `show` prop and
// supplies the target player + queue match id; the dialog owns the
// comment input, submit state and error display.
import { ref, watch, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { AlertTriangle, Loader2, Check } from 'lucide-vue-next'
import ModalOverlay from '@/components/common/ModalOverlay.vue'
import { useApi } from '@/composables/useApi'

interface ReportablePlayer {
  id: number
  name: string
  avatarUrl?: string | null
}

const props = defineProps<{
  show: boolean
  kind: 'toxic' | 'grief'
  player: ReportablePlayer | null
  queueMatchId: number | null
}>()
const emit = defineEmits<{
  close: []
  submitted: []
}>()

const { t } = useI18n()
const api = useApi()

const comment = ref('')
const submitting = ref(false)
const errorText = ref<string | null>(null)
const successFlash = ref(false)

// Reset every time the dialog opens — never leak state from a prior
// report against a different player.
watch(() => props.show, (open) => {
  if (open) {
    comment.value = ''
    submitting.value = false
    errorText.value = null
    successFlash.value = false
  }
})

const commentRequired = computed(() => props.kind === 'grief')
const canSubmit = computed(() => {
  if (submitting.value) return false
  if (!props.player || !props.queueMatchId) return false
  if (commentRequired.value && !comment.value.trim()) return false
  return true
})

async function submit() {
  if (!canSubmit.value || !props.player || !props.queueMatchId) return
  submitting.value = true
  errorText.value = null
  try {
    if (props.kind === 'toxic') {
      await api.reportToxic({
        queue_match_id: props.queueMatchId,
        reported_player_id: props.player.id,
        comment: comment.value.trim() || undefined,
      })
    } else {
      await api.reportGrief({
        queue_match_id: props.queueMatchId,
        reported_player_id: props.player.id,
        comment: comment.value.trim(),
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
        <h2 class="text-base font-semibold">
          {{ kind === 'toxic' ? t('inhouseReportToxicTitle') : t('inhouseReportGriefTitle') }}
        </h2>
        <p v-if="player" class="text-xs text-muted-foreground mt-0.5">
          {{ t('inhouseReportAgainst', { name: player.name }) }}
        </p>
      </div>
    </div>

    <div class="px-6 py-5 flex flex-col gap-3">
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
