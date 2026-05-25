<script setup lang="ts">
import { computed } from 'vue'
import { User } from 'lucide-vue-next'
import { useCosmetics } from '@/composables/useCosmetics'

// Shared player avatar with an optional decoration overlay (avatar_decoration
// perk). Pass `playerId` and the decoration is resolved from the cosmetics
// store automatically; pass `decorationUrl` to override (e.g. own live preview).
// Use this anywhere a player avatar is shown so decorations appear app-wide.
const props = withDefaults(defineProps<{
  avatarUrl?: string | null
  playerId?: number | null
  decorationUrl?: string | null
  size?: number
  rounded?: boolean
  alt?: string
}>(), { avatarUrl: null, playerId: null, decorationUrl: null, size: 40, rounded: true, alt: '' })

const cosmetics = useCosmetics()
// undefined override → fall back to the store; explicit null → show none.
const deco = computed(() =>
  props.decorationUrl !== undefined && props.decorationUrl !== null
    ? props.decorationUrl
    : cosmetics.decorationFor(props.playerId),
)
const dim = computed(() => `${props.size}px`)
const radius = computed(() => (props.rounded ? 'rounded-full' : 'rounded'))
</script>

<template>
  <span class="relative inline-block shrink-0 align-middle" :style="{ width: dim, height: dim }">
    <img v-if="avatarUrl" :src="avatarUrl" :alt="alt" class="w-full h-full object-cover block" :class="radius" />
    <span v-else class="w-full h-full flex items-center justify-center bg-accent/40 text-muted-foreground" :class="radius">
      <User class="w-1/2 h-1/2" />
    </span>
    <img
      v-if="deco"
      :src="deco"
      alt=""
      aria-hidden="true"
      class="pointer-events-none select-none absolute inset-0 w-full h-full object-contain"
    />
  </span>
</template>
