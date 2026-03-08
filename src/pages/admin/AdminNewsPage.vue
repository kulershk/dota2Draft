<script setup lang="ts">
import { Newspaper, Plus, Pencil, Trash2, Calendar, User } from 'lucide-vue-next'
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useApi } from '@/composables/useApi'
import ModalOverlay from '@/components/common/ModalOverlay.vue'
import InputGroup from '@/components/common/InputGroup.vue'
import RichTextEditor from '@/components/common/RichTextEditor.vue'

const { t } = useI18n()
const api = useApi()

interface NewsPost { id: number; title: string; content: string; created_by_name: string | null; created_by_avatar: string | null; created_at: string }
const newsList = ref<NewsPost[]>([])
const showAddNews = ref(false)
const showEditNews = ref(false)
const newNews = ref({ title: '', content: '' })
const editNews = ref({ id: 0, title: '', content: '' })

async function fetchNews() { newsList.value = await api.getNews() }
fetchNews()

async function addNews() {
  if (!newNews.value.title || !newNews.value.content) return
  await api.createNews(newNews.value)
  newNews.value = { title: '', content: '' }
  showAddNews.value = false
  fetchNews()
}

function openEditNews(post: NewsPost) {
  editNews.value = { id: post.id, title: post.title, content: post.content }
  showEditNews.value = true
}

async function saveNews() {
  await api.updateNews(editNews.value.id, { title: editNews.value.title, content: editNews.value.content })
  showEditNews.value = false
  fetchNews()
}

async function deleteNews(id: number) {
  await api.deleteNews(id)
  fetchNews()
}

function formatDate(dateStr: string) {
  const d = new Date(dateStr)
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}
</script>

<template>
  <div class="p-4 md:p-8 md:px-10 flex flex-col gap-4 md:gap-6 max-w-[1200px] mx-auto w-full">
    <div class="flex items-center justify-between">
      <div>
        <h1 class="text-2xl font-semibold text-foreground">{{ t('newsAnnouncements') }}</h1>
        <p class="text-sm text-muted-foreground mt-1">{{ t('manageNews') }}</p>
      </div>
      <button class="btn-primary text-sm" @click="showAddNews = true">
        <Plus class="w-4 h-4" />
        {{ t('addPost') }}
      </button>
    </div>

    <!-- News List -->
    <div class="card">
      <div v-if="newsList.length === 0" class="px-4 py-12 text-center text-sm text-muted-foreground">
        {{ t('noNewsPosts') }}
      </div>
      <div v-else class="divide-y divide-border">
        <div v-for="post in newsList" :key="post.id" class="px-4 py-4 md:px-6">
          <div class="flex items-start justify-between gap-3">
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-3">
                <h3 class="text-base font-semibold text-foreground">{{ post.title }}</h3>
                <span v-if="post.created_by_name" class="flex items-center gap-1 text-xs text-muted-foreground whitespace-nowrap">
                  <User class="w-3 h-3" />
                  {{ post.created_by_name }}
                </span>
                <span class="flex items-center gap-1 text-xs text-muted-foreground whitespace-nowrap">
                  <Calendar class="w-3 h-3" />
                  {{ formatDate(post.created_at) }}
                </span>
              </div>
              <div class="prose prose-sm dark:prose-invert max-w-none mt-2 text-muted-foreground line-clamp-3" v-html="post.content"></div>
            </div>
            <div class="flex items-center gap-1 shrink-0">
              <button class="btn-ghost p-2" title="Edit" @click="openEditNews(post)">
                <Pencil class="w-4 h-4" />
              </button>
              <button class="btn-ghost p-2 text-destructive" title="Delete" @click="deleteNews(post.id)">
                <Trash2 class="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Add News Modal -->
    <ModalOverlay :show="showAddNews" wide @close="showAddNews = false">
      <div class="border-b border-border px-7 py-6">
        <h2 class="text-xl font-semibold text-foreground">{{ t('addNewsModal.title') }}</h2>
        <p class="text-sm text-muted-foreground mt-1">{{ t('addNewsModal.subtitle') }}</p>
      </div>
      <div class="px-7 py-5 flex flex-col gap-5">
        <InputGroup :label="t('addNewsModal.titleLabel')" :model-value="newNews.title" :placeholder="t('addNewsModal.titlePlaceholder')" @update:model-value="newNews.title = $event" />
        <div class="flex flex-col gap-1.5">
          <label class="label-text">{{ t('addNewsModal.content') }}</label>
          <RichTextEditor v-model="newNews.content" />
        </div>
      </div>
      <div class="px-7 py-5 flex flex-col gap-3 border-t border-border">
        <button class="btn-primary w-full justify-center" @click="addNews">
          <Plus class="w-4 h-4" />
          {{ t('addNewsModal.publish') }}
        </button>
        <button class="btn-secondary w-full justify-center" @click="showAddNews = false">{{ t('cancel') }}</button>
      </div>
    </ModalOverlay>

    <!-- Edit News Modal -->
    <ModalOverlay :show="showEditNews" wide @close="showEditNews = false">
      <div class="border-b border-border px-7 py-6">
        <h2 class="text-xl font-semibold text-foreground">{{ t('editNewsModal.title') }}</h2>
      </div>
      <div class="px-7 py-5 flex flex-col gap-5">
        <InputGroup :label="t('editNewsModal.titleLabel')" :model-value="editNews.title" placeholder="Title" @update:model-value="editNews.title = $event" />
        <div class="flex flex-col gap-1.5">
          <label class="label-text">{{ t('editNewsModal.content') }}</label>
          <RichTextEditor v-model="editNews.content" />
        </div>
      </div>
      <div class="px-7 py-5 flex flex-col gap-3 border-t border-border">
        <button class="btn-primary w-full justify-center" @click="saveNews">
          <Pencil class="w-4 h-4" />
          {{ t('editNewsModal.save') }}
        </button>
        <button class="btn-secondary w-full justify-center" @click="showEditNews = false">{{ t('cancel') }}</button>
      </div>
    </ModalOverlay>
  </div>
</template>
