<script setup lang="ts">
defineProps<{
  label: string
  modelValue: string
  placeholder?: string
  rows?: number
}>()
defineEmits<{ 'update:modelValue': [value: string] }>()
</script>

<template>
  <div class="flex flex-col gap-1.5">
    <label class="label-text">{{ label }}</label>
    <textarea
      :value="modelValue"
      :placeholder="placeholder"
      :rows="rows || 3"
      class="textarea-field"
      @input="$emit('update:modelValue', ($event.target as HTMLTextAreaElement).value)"
    />
  </div>
</template>
