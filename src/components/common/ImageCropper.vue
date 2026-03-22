<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch, nextTick } from 'vue'
import Cropper from 'cropperjs'
import 'cropperjs/dist/cropper.css'
import { useI18n } from 'vue-i18n'
import ModalOverlay from './ModalOverlay.vue'

const { t } = useI18n()

const props = defineProps<{
  show: boolean
  imageFile: File | null
  aspectRatio?: number
  outputSize?: number
  outputWidth?: number
  outputHeight?: number
}>()

const emit = defineEmits<{
  (e: 'crop', blob: Blob): void
  (e: 'close'): void
}>()

const imageEl = ref<HTMLImageElement | null>(null)
let cropper: Cropper | null = null
let objectUrl: string | null = null
const cropping = ref(false)

function initCropper() {
  destroyCropper()
  if (!props.imageFile || !imageEl.value) return

  objectUrl = URL.createObjectURL(props.imageFile)
  imageEl.value.src = objectUrl

  nextTick(() => {
    if (!imageEl.value) return
    cropper = new Cropper(imageEl.value, {
      aspectRatio: props.aspectRatio ?? 1,
      viewMode: 1,
      dragMode: 'move',
      autoCropArea: 1,
      cropBoxResizable: true,
      cropBoxMovable: true,
      background: false,
      responsive: true,
    })
  })
}

function destroyCropper() {
  if (cropper) {
    cropper.destroy()
    cropper = null
  }
  if (objectUrl) {
    URL.revokeObjectURL(objectUrl)
    objectUrl = null
  }
}

async function doCrop() {
  if (!cropper) return
  cropping.value = true
  const w = props.outputWidth ?? props.outputSize ?? 256
  const h = props.outputHeight ?? props.outputSize ?? 256
  const canvas = cropper.getCroppedCanvas({
    width: w,
    height: h,
    imageSmoothingEnabled: true,
    imageSmoothingQuality: 'high',
  })
  canvas.toBlob((blob) => {
    if (blob) emit('crop', blob)
    cropping.value = false
  }, 'image/png')
}

watch(() => props.show, (val) => {
  if (val && props.imageFile) {
    nextTick(initCropper)
  } else {
    destroyCropper()
  }
})

onUnmounted(destroyCropper)
</script>

<template>
  <ModalOverlay :show="show" @close="emit('close')">
    <div class="border-b border-border px-7 py-6">
      <h2 class="text-xl font-semibold text-foreground">{{ t('cropImage') }}</h2>
      <p class="text-sm text-muted-foreground mt-1">{{ t('cropImageHint') }}</p>
    </div>
    <div class="px-7 py-5">
      <div class="max-h-[400px] overflow-hidden rounded-lg bg-black/5">
        <img ref="imageEl" class="block max-w-full" />
      </div>
    </div>
    <div class="px-7 py-5 flex flex-col gap-3 border-t border-border">
      <button class="btn-primary w-full justify-center" :disabled="cropping" @click="doCrop">
        {{ cropping ? t('processing') : t('cropAndUpload') }}
      </button>
      <button class="btn-secondary w-full justify-center" @click="emit('close')">{{ t('cancel') }}</button>
    </div>
  </ModalOverlay>
</template>
