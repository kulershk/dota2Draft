<script setup lang="ts">
import { useEditor, EditorContent } from '@tiptap/vue-3'
import StarterKit from '@tiptap/starter-kit'
import Underline from '@tiptap/extension-underline'
import Link from '@tiptap/extension-link'
import TextAlign from '@tiptap/extension-text-align'
import { watch } from 'vue'
import {
  Bold, Italic, Underline as UnderlineIcon, Strikethrough,
  List, ListOrdered, Quote, Minus, Link as LinkIcon, Unlink,
  AlignLeft, AlignCenter, AlignRight, Heading1, Heading2, Heading3, Undo2, Redo2
} from 'lucide-vue-next'

const props = defineProps<{
  modelValue: string
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string]
}>()

const editor = useEditor({
  content: props.modelValue,
  extensions: [
    StarterKit,
    Underline,
    Link.configure({ openOnClick: false }),
    TextAlign.configure({ types: ['heading', 'paragraph'] }),
  ],
  editorProps: {
    attributes: {
      class: 'prose prose-sm dark:prose-invert max-w-none focus:outline-none min-h-[150px] px-4 py-3',
    },
  },
  onUpdate: () => {
    emit('update:modelValue', editor.value?.getHTML() || '')
  },
})

watch(() => props.modelValue, (val) => {
  if (editor.value && editor.value.getHTML() !== val) {
    editor.value.commands.setContent(val, false)
  }
})

function setLink() {
  const url = window.prompt('URL', editor.value?.getAttributes('link').href || '')
  if (url === null) return
  if (url === '') {
    editor.value?.chain().focus().extendMarkRange('link').unsetLink().run()
    return
  }
  editor.value?.chain().focus().extendMarkRange('link').setLink({ href: url }).run()
}
</script>

<template>
  <div class="border border-border rounded-lg overflow-hidden bg-background">
    <!-- Toolbar -->
    <div v-if="editor" class="flex flex-wrap items-center gap-0.5 px-2 py-1.5 border-b border-border bg-accent/30">
      <button type="button" class="toolbar-btn" :class="{ active: editor.isActive('bold') }" title="Bold" @click="editor.chain().focus().toggleBold().run()">
        <Bold class="w-4 h-4" />
      </button>
      <button type="button" class="toolbar-btn" :class="{ active: editor.isActive('italic') }" title="Italic" @click="editor.chain().focus().toggleItalic().run()">
        <Italic class="w-4 h-4" />
      </button>
      <button type="button" class="toolbar-btn" :class="{ active: editor.isActive('underline') }" title="Underline" @click="editor.chain().focus().toggleUnderline().run()">
        <UnderlineIcon class="w-4 h-4" />
      </button>
      <button type="button" class="toolbar-btn" :class="{ active: editor.isActive('strike') }" title="Strikethrough" @click="editor.chain().focus().toggleStrike().run()">
        <Strikethrough class="w-4 h-4" />
      </button>

      <div class="w-px h-5 bg-border mx-1"></div>

      <button type="button" class="toolbar-btn" :class="{ active: editor.isActive('heading', { level: 1 }) }" title="Heading 1" @click="editor.chain().focus().toggleHeading({ level: 1 }).run()">
        <Heading1 class="w-4 h-4" />
      </button>
      <button type="button" class="toolbar-btn" :class="{ active: editor.isActive('heading', { level: 2 }) }" title="Heading 2" @click="editor.chain().focus().toggleHeading({ level: 2 }).run()">
        <Heading2 class="w-4 h-4" />
      </button>
      <button type="button" class="toolbar-btn" :class="{ active: editor.isActive('heading', { level: 3 }) }" title="Heading 3" @click="editor.chain().focus().toggleHeading({ level: 3 }).run()">
        <Heading3 class="w-4 h-4" />
      </button>

      <div class="w-px h-5 bg-border mx-1"></div>

      <button type="button" class="toolbar-btn" :class="{ active: editor.isActive({ textAlign: 'left' }) }" title="Align Left" @click="editor.chain().focus().setTextAlign('left').run()">
        <AlignLeft class="w-4 h-4" />
      </button>
      <button type="button" class="toolbar-btn" :class="{ active: editor.isActive({ textAlign: 'center' }) }" title="Align Center" @click="editor.chain().focus().setTextAlign('center').run()">
        <AlignCenter class="w-4 h-4" />
      </button>
      <button type="button" class="toolbar-btn" :class="{ active: editor.isActive({ textAlign: 'right' }) }" title="Align Right" @click="editor.chain().focus().setTextAlign('right').run()">
        <AlignRight class="w-4 h-4" />
      </button>

      <div class="w-px h-5 bg-border mx-1"></div>

      <button type="button" class="toolbar-btn" :class="{ active: editor.isActive('bulletList') }" title="Bullet List" @click="editor.chain().focus().toggleBulletList().run()">
        <List class="w-4 h-4" />
      </button>
      <button type="button" class="toolbar-btn" :class="{ active: editor.isActive('orderedList') }" title="Ordered List" @click="editor.chain().focus().toggleOrderedList().run()">
        <ListOrdered class="w-4 h-4" />
      </button>
      <button type="button" class="toolbar-btn" :class="{ active: editor.isActive('blockquote') }" title="Quote" @click="editor.chain().focus().toggleBlockquote().run()">
        <Quote class="w-4 h-4" />
      </button>
      <button type="button" class="toolbar-btn" title="Horizontal Rule" @click="editor.chain().focus().setHorizontalRule().run()">
        <Minus class="w-4 h-4" />
      </button>

      <div class="w-px h-5 bg-border mx-1"></div>

      <button type="button" class="toolbar-btn" :class="{ active: editor.isActive('link') }" title="Add Link" @click="setLink">
        <LinkIcon class="w-4 h-4" />
      </button>
      <button type="button" class="toolbar-btn" title="Remove Link" :disabled="!editor.isActive('link')" @click="editor.chain().focus().unsetLink().run()">
        <Unlink class="w-4 h-4" />
      </button>

      <div class="w-px h-5 bg-border mx-1"></div>

      <button type="button" class="toolbar-btn" title="Undo" :disabled="!editor.can().undo()" @click="editor.chain().focus().undo().run()">
        <Undo2 class="w-4 h-4" />
      </button>
      <button type="button" class="toolbar-btn" title="Redo" :disabled="!editor.can().redo()" @click="editor.chain().focus().redo().run()">
        <Redo2 class="w-4 h-4" />
      </button>
    </div>

    <!-- Editor -->
    <EditorContent :editor="editor" />
  </div>
</template>

<style scoped>
.toolbar-btn {
  @apply p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors disabled:opacity-30 disabled:pointer-events-none;
}
.toolbar-btn.active {
  @apply text-primary bg-primary/10;
}
</style>
