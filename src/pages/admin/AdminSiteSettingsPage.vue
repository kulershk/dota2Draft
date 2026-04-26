<script setup lang="ts">
import { Settings, Save, Upload, Trash2, Plus, Image } from 'lucide-vue-next'
import { ref, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useApi } from '@/composables/useApi'

const { t } = useI18n()
const api = useApi()

const siteName = ref('')
const siteTitle = ref('')
const siteSubtitle = ref('')
const siteHeroParagraph = ref('')
const discordUrl = ref('')
const logoUrl = ref('')
const heroBannerUrl = ref('')
const saving = ref(false)
const saved = ref(false)
const uploadingLogo = ref(false)
const uploadingBanner = ref(false)

interface Sponsor { id: number; logo_url: string; alt: string; link: string }
const sponsors = ref<Sponsor[]>([])
const newSponsorFile = ref<File | null>(null)
const newSponsorAlt = ref('')
const newSponsorLink = ref('')
const uploadingSponsor = ref(false)
const editingSponsorId = ref<number | null>(null)
const editAlt = ref('')
const editLink = ref('')

onMounted(async () => {
  const data = await api.getSiteSettings()
  siteName.value = data.site_name || ''
  siteTitle.value = data.site_title || ''
  siteSubtitle.value = data.site_subtitle || ''
  siteHeroParagraph.value = data.site_hero_paragraph || ''
  discordUrl.value = data.site_discord_url || ''
  logoUrl.value = data.site_logo_url || ''
  heroBannerUrl.value = data.site_hero_banner_url || ''
  sponsors.value = data.site_sponsors || []
})

function pickSponsorFile(e: Event) {
  const input = e.target as HTMLInputElement
  newSponsorFile.value = input.files && input.files[0] || null
}
async function addSponsor() {
  if (!newSponsorFile.value) return
  uploadingSponsor.value = true
  try {
    const result = await api.uploadSponsor(newSponsorFile.value, newSponsorAlt.value, newSponsorLink.value)
    sponsors.value = result.sponsors
    newSponsorFile.value = null
    newSponsorAlt.value = ''
    newSponsorLink.value = ''
    const fileInput = document.getElementById('sponsorFileInput') as HTMLInputElement | null
    if (fileInput) fileInput.value = ''
  } finally {
    uploadingSponsor.value = false
  }
}
function startEditSponsor(s: Sponsor) {
  editingSponsorId.value = s.id
  editAlt.value = s.alt
  editLink.value = s.link
}
async function saveSponsor(s: Sponsor) {
  const result = await api.updateSponsor(s.id, { alt: editAlt.value, link: editLink.value })
  sponsors.value = result.sponsors
  editingSponsorId.value = null
}
async function removeSponsor(s: Sponsor) {
  if (!confirm(t('sponsorDeleteConfirm', { alt: s.alt || '#' + s.id }))) return
  const result = await api.deleteSponsor(s.id)
  sponsors.value = result.sponsors
}

async function saveSettings() {
  saving.value = true
  saved.value = false
  try {
    await api.updateSiteSettings({
      site_name: siteName.value,
      site_title: siteTitle.value,
      site_subtitle: siteSubtitle.value,
      site_hero_paragraph: siteHeroParagraph.value,
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

async function handleBannerUpload(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0]
  if (!file) return
  uploadingBanner.value = true
  try {
    const result = await api.uploadSiteHeroBanner(file)
    heroBannerUrl.value = result.site_hero_banner_url
  } finally {
    uploadingBanner.value = false
  }
}

async function removeBanner() {
  await api.deleteSiteHeroBanner()
  heroBannerUrl.value = ''
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
          <label class="block text-xs font-medium text-muted-foreground mb-1">Hero Banner</label>
          <!-- Live preview -->
          <div class="relative overflow-hidden rounded-lg border border-border mb-3">
            <div v-if="heroBannerUrl" class="absolute inset-0">
              <img :src="heroBannerUrl" class="w-full h-full object-cover" />
              <div class="absolute inset-0 bg-gradient-to-b from-background/70 via-background/50 to-background" />
            </div>
            <div class="relative flex flex-col items-center text-center py-10 px-6">
              <span class="text-lg font-bold text-foreground">{{ siteTitle || 'Site Title' }}</span>
              <span class="text-xs text-muted-foreground mt-1">{{ siteSubtitle || 'Subtitle text' }}</span>
            </div>
          </div>
          <div class="flex items-center gap-3">
            <label class="btn-secondary cursor-pointer text-xs">
              <Upload class="w-3.5 h-3.5" />
              {{ uploadingBanner ? t('loading') : 'Upload Banner' }}
              <input type="file" accept="image/*" class="hidden" @change="handleBannerUpload" />
            </label>
            <button v-if="heroBannerUrl" class="btn-ghost text-xs text-destructive" @click="removeBanner">
              <Trash2 class="w-3.5 h-3.5" />
              Remove
            </button>
          </div>
          <p class="text-[11px] text-muted-foreground mt-1.5">Recommended: 1200×400px. Displayed as the hero background on the home page.</p>
        </div>
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
          <label class="block text-xs font-medium text-muted-foreground mb-1">{{ t('siteHeroParagraph') }}</label>
          <textarea v-model="siteHeroParagraph" rows="3" class="input-field w-full" :placeholder="t('siteHeroParagraphPlaceholder')"></textarea>
          <p class="text-[11px] text-muted-foreground mt-1">{{ t('siteHeroParagraphHint') }}</p>
        </div>
        <div>
          <label class="block text-xs font-medium text-muted-foreground mb-1">{{ t('siteDiscordUrl') }}</label>
          <input type="text" v-model="discordUrl" class="input-field w-full" placeholder="https://discord.gg/..." />
          <p class="text-[11px] text-muted-foreground mt-1">{{ t('siteDiscordUrlHint') }}</p>
        </div>
      </div>
    </div>

    <!-- Sponsors -->
    <div class="card">
      <div class="flex items-center gap-2 px-5 py-3 border-b border-border">
        <Image class="w-4 h-4 text-foreground" />
        <span class="text-sm font-semibold text-foreground">{{ t('sponsorsTitle') }}</span>
        <span class="text-xs text-muted-foreground ml-2">{{ t('sponsorsHint') }}</span>
      </div>
      <div class="px-5 py-4 flex flex-col gap-4">
        <!-- Existing list -->
        <div v-if="sponsors.length === 0" class="text-xs text-muted-foreground text-center py-2">{{ t('sponsorsEmpty') }}</div>
        <div v-else class="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div v-for="s in sponsors" :key="s.id" class="flex items-center gap-3 p-3 rounded-md bg-accent/30 border border-border/40">
            <img :src="s.logo_url" :alt="s.alt" class="w-16 h-12 object-contain bg-[#0F1A2E] rounded" />
            <div class="flex-1 min-w-0">
              <template v-if="editingSponsorId === s.id">
                <input v-model="editAlt" type="text" :placeholder="t('sponsorAlt')" class="input-field w-full text-xs mb-1" />
                <input v-model="editLink" type="text" :placeholder="t('sponsorLink')" class="input-field w-full text-xs" />
              </template>
              <template v-else>
                <p class="text-sm font-semibold truncate">{{ s.alt || '—' }}</p>
                <a v-if="s.link" :href="s.link" target="_blank" class="text-[11px] text-primary truncate block hover:underline">{{ s.link }}</a>
              </template>
            </div>
            <div class="flex items-center gap-1">
              <button v-if="editingSponsorId === s.id" type="button" class="px-2 py-1 text-xs rounded bg-primary/15 text-primary hover:bg-primary/25" @click="saveSponsor(s)">{{ t('save') }}</button>
              <button v-else type="button" class="p-1.5 rounded hover:bg-accent text-muted-foreground" @click="startEditSponsor(s)" :title="t('edit')">
                <Settings class="w-3.5 h-3.5" />
              </button>
              <button type="button" class="p-1.5 rounded hover:bg-destructive/15 text-muted-foreground hover:text-destructive" @click="removeSponsor(s)" :title="t('delete')">
                <Trash2 class="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        </div>

        <!-- Upload new -->
        <div class="border-t border-border/40 pt-4 grid grid-cols-1 md:grid-cols-[1fr_1fr_1fr_auto] gap-3 items-end">
          <div>
            <label class="block text-[11px] font-medium text-muted-foreground mb-1">{{ t('sponsorLogo') }}</label>
            <input id="sponsorFileInput" type="file" accept="image/*" @change="pickSponsorFile" class="block w-full text-xs text-muted-foreground file:mr-3 file:py-1.5 file:px-3 file:rounded file:border-0 file:bg-primary file:text-[#0A0F1C] file:font-semibold hover:file:brightness-110 file:cursor-pointer" />
          </div>
          <div>
            <label class="block text-[11px] font-medium text-muted-foreground mb-1">{{ t('sponsorAlt') }}</label>
            <input v-model="newSponsorAlt" type="text" class="input-field w-full" :placeholder="t('sponsorAltPlaceholder')" />
          </div>
          <div>
            <label class="block text-[11px] font-medium text-muted-foreground mb-1">{{ t('sponsorLink') }}</label>
            <input v-model="newSponsorLink" type="text" class="input-field w-full" placeholder="https://..." />
          </div>
          <button type="button" class="btn-primary px-3 py-2 flex items-center gap-1.5 disabled:opacity-40" :disabled="uploadingSponsor || !newSponsorFile" @click="addSponsor">
            <Plus class="w-4 h-4" />
            {{ uploadingSponsor ? `${t('saving')}…` : t('add') }}
          </button>
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
