<script setup lang="ts">
import { Gamepad2 } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'
import { ref, onMounted } from 'vue'
import { useApi } from '@/composables/useApi'

const { t } = useI18n()
const api = useApi()

const siteName = ref('')
const logoUrl = ref('')

onMounted(() => {
  const apply = (data: any) => {
    siteName.value = data.site_name || ''
    logoUrl.value = data.site_logo_url || ''
  }
  const { cached, fresh } = api.getSiteSettingsCached()
  if (cached) apply(cached)
  fresh.then(apply).catch(() => {})
})
</script>

<template>
  <footer class="border-t border-border bg-sidebar">
    <div class="max-w-[1200px] mx-auto px-4 md:px-6 py-6 flex flex-col gap-4">
      <div class="flex flex-col sm:flex-row items-center justify-between gap-3">
        <div class="flex items-center gap-2">
          <img v-if="logoUrl" :src="logoUrl" class="w-6 h-6 rounded object-contain" />
          <div v-else class="w-6 h-6 rounded bg-primary flex items-center justify-center">
            <Gamepad2 class="w-3 h-3 text-primary-foreground" />
          </div>
          <span class="text-xs font-semibold text-foreground">{{ siteName || t('appTitle') }}</span>
        </div>
        <div class="flex items-center gap-4">
          <router-link to="/how-it-works" class="text-xs text-muted-foreground hover:text-foreground transition-colors">{{ t('howItWorksTitle') }}</router-link>
        </div>
      </div>
      <div class="flex flex-col sm:flex-row items-center justify-between gap-2 pt-3 border-t border-border/50">
        <p class="text-xs text-muted-foreground">&copy; {{ new Date().getFullYear() }} {{ siteName || t('appTitle') }}. {{ t('allRightsReserved') }}</p>
        <p class="text-xs text-muted-foreground">{{ t('createdBy') }} <router-link :to="{ name: 'player-profile', params: { id: 33 } }" class="text-primary hover:text-primary/80 transition-colors font-medium">kulers</router-link></p>
      </div>
    </div>
  </footer>
</template>
