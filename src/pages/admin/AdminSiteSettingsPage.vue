<script setup lang="ts">
import { Settings, Save, Upload, Trash2 } from 'lucide-vue-next'
import { ref, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useApi } from '@/composables/useApi'

const { t } = useI18n()
const api = useApi()

const siteName = ref('')
const siteTitle = ref('')
const siteSubtitle = ref('')
const discordUrl = ref('')
const logoUrl = ref('')
const saving = ref(false)
const saved = ref(false)
const uploadingLogo = ref(false)

onMounted(async () => {
  const data = await api.getSiteSettings()
  siteName.value = data.site_name || ''
  siteTitle.value = data.site_title || ''
  siteSubtitle.value = data.site_subtitle || ''
  discordUrl.value = data.site_discord_url || ''
  logoUrl.value = data.site_logo_url || ''
})

async function saveSettings() {
  saving.value = true
  saved.value = false
  try {
    await api.updateSiteSettings({
      site_name: siteName.value,
      site_title: siteTitle.value,
      site_subtitle: siteSubtitle.value,
      site_discord_url: discordUrl.value,
    })
    saved.value = true
    setTimeout(() => { saved.value = false }, 3000)
  } finally {
    saving.value = false
  }
}

async function handleLogoUpload(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0]
  if (!file) return
  uploadingLogo.value = true
  try {
    const result = await api.uploadSiteLogo(file)
    logoUrl.value = result.site_logo_url
  } finally {
    uploadingLogo.value = false
  }
}

async function removeLogo() {
  await api.deleteSiteLogo()
  logoUrl.value = ''
}
</script>

<template>
  <div class="p-4 md:p-8 md:px-10 flex flex-col gap-6 max-w-[800px]">
    <div>
      <h1 class="text-xl font-semibold text-foreground">{{ t('siteSettings') }}</h1>
      <p class="text-sm text-muted-foreground mt-1">{{ t('siteSettingsDesc') }}</p>
    </div>

    <!-- Branding -->
    <div class="card">
      <div class="flex items-center gap-2 px-5 py-3 border-b border-border">
        <Settings class="w-4 h-4 text-foreground" />
        <span class="text-sm font-semibold text-foreground">{{ t('siteBranding') }}</span>
      </div>
      <div class="px-5 py-4 flex flex-col gap-4">
        <div>
          <label class="block text-xs font-medium text-muted-foreground mb-1">{{ t('siteLogo') }}</label>
          <div class="flex items-center gap-4">
            <div v-if="logoUrl" class="relative">
              <img :src="logoUrl" class="w-14 h-14 rounded-lg object-contain border border-border bg-accent/30" />
              <button class="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-destructive text-white flex items-center justify-center" @click="removeLogo">
                <Trash2 class="w-3 h-3" />
              </button>
            </div>
            <label class="btn-secondary cursor-pointer text-xs">
              <Upload class="w-3.5 h-3.5" />
              {{ uploadingLogo ? t('loading') : t('uploadLogo') }}
              <input type="file" accept="image/*" class="hidden" @change="handleLogoUpload" />
            </label>
          </div>
          <p class="text-[11px] text-muted-foreground mt-1.5">{{ t('siteLogoHint') }}</p>
        </div>
        <div>
          <label class="block text-xs font-medium text-muted-foreground mb-1">{{ t('siteNameLabel') }}</label>
          <input type="text" v-model="siteName" class="input-field w-full" :placeholder="t('appTitle')" />
          <p class="text-[11px] text-muted-foreground mt-1">{{ t('siteNameHint') }}</p>
        </div>
      </div>
    </div>

    <!-- Homepage Content -->
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
        <div>
          <label class="block text-xs font-medium text-muted-foreground mb-1">{{ t('siteDiscordUrl') }}</label>
          <input type="text" v-model="discordUrl" class="input-field w-full" placeholder="https://discord.gg/..." />
          <p class="text-[11px] text-muted-foreground mt-1">{{ t('siteDiscordUrlHint') }}</p>
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
