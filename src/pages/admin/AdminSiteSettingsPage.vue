<script setup lang="ts">
import { Settings, Save } from 'lucide-vue-next'
import { ref, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useApi } from '@/composables/useApi'

const { t } = useI18n()
const api = useApi()

const siteTitle = ref('')
const siteSubtitle = ref('')
const saving = ref(false)
const saved = ref(false)

onMounted(async () => {
  const data = await api.getSiteSettings()
  siteTitle.value = data.site_title || ''
  siteSubtitle.value = data.site_subtitle || ''
})

async function saveSettings() {
  saving.value = true
  saved.value = false
  try {
    await api.updateSiteSettings({
      site_title: siteTitle.value,
      site_subtitle: siteSubtitle.value,
    })
    saved.value = true
    setTimeout(() => { saved.value = false }, 3000)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="p-4 md:p-8 md:px-10 flex flex-col gap-6 max-w-[800px]">
    <div>
      <h1 class="text-xl font-semibold text-foreground">{{ t('siteSettings') }}</h1>
      <p class="text-sm text-muted-foreground mt-1">{{ t('siteSettingsDesc') }}</p>
    </div>

    <div class="card">
      <div class="flex items-center gap-2 px-5 py-3 border-b border-border">
        <Settings class="w-4 h-4 text-foreground" />
        <span class="text-sm font-semibold text-foreground">{{ t('homepageContent') }}</span>
      </div>
      <div class="px-5 py-4 flex flex-col gap-4">
        <div>
          <label class="block text-xs font-medium text-muted-foreground mb-1">{{ t('siteHeroTitle') }}</label>
          <input type="text" v-model="siteTitle" class="input-field w-full" :placeholder="t('heroTitle')" />
          <p class="text-[11px] text-muted-foreground mt-1">{{ t('siteHeroTitleHint') }}</p>
        </div>
        <div>
          <label class="block text-xs font-medium text-muted-foreground mb-1">{{ t('siteHeroSubtitle') }}</label>
          <input type="text" v-model="siteSubtitle" class="input-field w-full" :placeholder="t('heroSubtitle')" />
          <p class="text-[11px] text-muted-foreground mt-1">{{ t('siteHeroSubtitleHint') }}</p>
        </div>
      </div>
    </div>

    <div class="flex items-center gap-3">
      <button class="btn-primary" :disabled="saving" @click="saveSettings">
        <Save class="w-4 h-4" />
        {{ saving ? t('saving') : t('saveSettings') }}
      </button>
      <span v-if="saved" class="text-sm text-color-success font-medium">{{ t('settingsSaved') }}</span>
    </div>
  </div>
</template>
