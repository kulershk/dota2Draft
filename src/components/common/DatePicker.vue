<script setup lang="ts">
import { ChevronLeft, ChevronRight, Calendar, Clock } from 'lucide-vue-next'
import { ref, computed, nextTick, onBeforeUnmount, watch } from 'vue'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()

// mode: 'single' = one date, 'range' = start+end
// showTime: show hour/minute pickers
const props = withDefaults(defineProps<{
  mode?: 'single' | 'range'
  showTime?: boolean
  label?: string
  startLabel?: string
  endLabel?: string
  placeholder?: string
  modelValue?: string
  modelStart?: string
  modelEnd?: string
}>(), {
  mode: 'single',
  showTime: false,
  placeholder: '—',
})

const emit = defineEmits<{
  'update:modelValue': [val: string]
  'update:modelStart': [val: string]
  'update:modelEnd': [val: string]
}>()

const open = ref(false)
const selecting = ref<'start' | 'end' | 'single'>('start')
const hoverDate = ref('')
const triggerRef = ref<HTMLElement | null>(null)
const dropdownPos = ref({ top: '0px', left: '0px' })

const viewYear = ref(new Date().getFullYear())
const viewMonth = ref(new Date().getMonth())

// Time state for single mode
const singleHour = ref('00')
const singleMinute = ref('00')
// Time state for range mode
const startHour = ref('00')
const startMinute = ref('00')
const endHour = ref('00')
const endMinute = ref('00')

function parseTime(str: string) {
  if (!str || str.length < 16) return { h: '00', m: '00' }
  return { h: str.slice(11, 13), m: str.slice(14, 16) }
}

// Sync time state when opening
function syncTimeFromProps() {
  if (props.mode === 'single') {
    const t = parseTime(props.modelValue || '')
    singleHour.value = t.h
    singleMinute.value = t.m
  } else {
    const st = parseTime(props.modelStart || '')
    startHour.value = st.h
    startMinute.value = st.m
    const et = parseTime(props.modelEnd || '')
    endHour.value = et.h
    endMinute.value = et.m
  }
}

function formatDisplay(str: string | undefined): string {
  if (!str) return props.placeholder
  const d = new Date(str)
  if (isNaN(d.getTime())) return props.placeholder
  let result = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  if (props.showTime && str.length >= 16) {
    result += ` ${str.slice(11, 16)}`
  }
  return result
}

function toDateStr(y: number, m: number, d: number, hour = '00', minute = '00'): string {
  return `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}T${hour}:${minute}`
}

function dateOnly(str: string | undefined): string {
  return str ? str.slice(0, 10) : ''
}

function withTime(dateStr: string, hour: string, minute: string): string {
  return dateStr.slice(0, 10) + `T${hour}:${minute}`
}

function getCalendarDays(year: number, month: number) {
  const first = new Date(year, month, 1)
  const startDay = (first.getDay() + 6) % 7
  const daysInMonth = new Date(year, month + 1, 0).getDate()
  const days: { day: number; date: string; outOfMonth: boolean }[] = []

  const prevDays = new Date(year, month, 0).getDate()
  for (let i = startDay - 1; i >= 0; i--) {
    const d = prevDays - i
    const m = month - 1 < 0 ? 11 : month - 1
    const y = month - 1 < 0 ? year - 1 : year
    days.push({ day: d, date: toDateStr(y, m, d), outOfMonth: true })
  }
  for (let d = 1; d <= daysInMonth; d++) {
    days.push({ day: d, date: toDateStr(year, month, d), outOfMonth: false })
  }
  const remaining = 42 - days.length
  for (let d = 1; d <= remaining; d++) {
    const m = month + 1 > 11 ? 0 : month + 1
    const y = month + 1 > 11 ? year + 1 : year
    days.push({ day: d, date: toDateStr(y, m, d), outOfMonth: true })
  }
  return days
}

const leftDays = computed(() => getCalendarDays(viewYear.value, viewMonth.value))
const rightDays = computed(() => {
  const m = viewMonth.value + 1 > 11 ? 0 : viewMonth.value + 1
  const y = viewMonth.value + 1 > 11 ? viewYear.value + 1 : viewYear.value
  return getCalendarDays(y, m)
})

const leftMonthLabel = computed(() => new Date(viewYear.value, viewMonth.value).toLocaleDateString('en-US', { month: 'long', year: 'numeric' }))
const rightMonthLabel = computed(() => {
  const m = viewMonth.value + 1 > 11 ? 0 : viewMonth.value + 1
  const y = viewMonth.value + 1 > 11 ? viewYear.value + 1 : viewYear.value
  return new Date(y, m).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
})

const showDualCalendar = computed(() => props.mode === 'range')

function prevMonth() {
  if (viewMonth.value === 0) { viewMonth.value = 11; viewYear.value-- }
  else viewMonth.value--
}
function nextMonth() {
  if (viewMonth.value === 11) { viewMonth.value = 0; viewYear.value++ }
  else viewMonth.value++
}

// Range helpers
function isInRange(dateStr: string) {
  if (props.mode !== 'range') return false
  const s = dateOnly(props.modelStart), e = dateOnly(props.modelEnd), d = dateOnly(dateStr)
  if (!s || !e) return false
  return d > s && d < e
}

function isHoverRange(dateStr: string) {
  if (props.mode !== 'range' || selecting.value !== 'end' || !props.modelStart || !hoverDate.value) return false
  const s = dateOnly(props.modelStart), h = dateOnly(hoverDate.value), d = dateOnly(dateStr)
  if (props.modelEnd) return false
  return d > s && d <= h
}

function isSelected(dateStr: string) {
  const d = dateOnly(dateStr)
  if (props.mode === 'single') return d === dateOnly(props.modelValue)
  return d === dateOnly(props.modelStart) || d === dateOnly(props.modelEnd)
}

function isStart(dateStr: string) { return props.mode === 'range' && dateOnly(dateStr) === dateOnly(props.modelStart) }
function isEnd(dateStr: string) { return props.mode === 'range' && dateOnly(dateStr) === dateOnly(props.modelEnd) }

function isToday(dateStr: string) {
  const today = new Date()
  return dateOnly(dateStr) === `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
}

function selectDate(dateStr: string) {
  if (props.mode === 'single') {
    const val = props.showTime ? withTime(dateStr, singleHour.value, singleMinute.value) : dateStr
    emit('update:modelValue', val)
    if (!props.showTime) open.value = false
  } else {
    if (selecting.value === 'start') {
      const val = props.showTime ? withTime(dateStr, startHour.value, startMinute.value) : dateStr
      emit('update:modelStart', val)
      if (props.modelEnd && dateOnly(dateStr) >= dateOnly(props.modelEnd)) {
        emit('update:modelEnd', '')
      }
      selecting.value = 'end'
    } else {
      if (dateOnly(dateStr) <= dateOnly(props.modelStart)) {
        const val = props.showTime ? withTime(dateStr, startHour.value, startMinute.value) : dateStr
        emit('update:modelStart', val)
        selecting.value = 'end'
      } else {
        const val = props.showTime ? withTime(dateStr, endHour.value, endMinute.value) : dateStr
        emit('update:modelEnd', val)
        selecting.value = 'start'
        if (!props.showTime) open.value = false
      }
    }
  }
}

// Time change handlers
function onSingleTimeChange() {
  if (props.modelValue && dateOnly(props.modelValue)) {
    emit('update:modelValue', withTime(props.modelValue, singleHour.value, singleMinute.value))
  }
}
function onStartTimeChange() {
  if (props.modelStart && dateOnly(props.modelStart)) {
    emit('update:modelStart', withTime(props.modelStart, startHour.value, startMinute.value))
  }
}
function onEndTimeChange() {
  if (props.modelEnd && dateOnly(props.modelEnd)) {
    emit('update:modelEnd', withTime(props.modelEnd, endHour.value, endMinute.value))
  }
}

function updatePosition() {
  if (!triggerRef.value) return
  const rect = triggerRef.value.getBoundingClientRect()
  dropdownPos.value = {
    top: `${rect.bottom + window.scrollY + 8}px`,
    left: `${rect.left + window.scrollX}px`,
  }
}

function openPicker(mode?: 'start' | 'end') {
  if (props.mode === 'range') {
    selecting.value = mode || 'start'
  } else {
    selecting.value = 'single'
  }
  // Set view month from existing value
  const refDate = props.mode === 'single' ? props.modelValue : props.modelStart
  if (refDate) {
    const d = new Date(refDate)
    if (!isNaN(d.getTime())) {
      viewYear.value = d.getFullYear()
      viewMonth.value = d.getMonth()
    }
  } else {
    const now = new Date()
    viewYear.value = now.getFullYear()
    viewMonth.value = now.getMonth()
  }
  syncTimeFromProps()
  open.value = true
  nextTick(updatePosition)
}

function clearDates() {
  if (props.mode === 'single') {
    emit('update:modelValue', '')
  } else {
    emit('update:modelStart', '')
    emit('update:modelEnd', '')
  }
  selecting.value = props.mode === 'range' ? 'start' : 'single'
}

function closePicker() { open.value = false }
onBeforeUnmount(() => { open.value = false })

const weekDays = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su']
const hours = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0'))
const minutes = Array.from({ length: 12 }, (_, i) => String(i * 5).padStart(2, '0'))

function dayClass(day: { date: string; outOfMonth: boolean }) {
  return [
    day.outOfMonth ? 'text-muted-foreground/40' : 'text-foreground',
    isSelected(day.date) ? 'bg-primary text-primary-foreground font-bold' : '',
    isInRange(day.date) ? 'bg-primary/15' : '',
    isHoverRange(day.date) ? 'bg-primary/10' : '',
    isToday(day.date) && !isSelected(day.date) ? 'ring-1 ring-primary' : '',
    !isSelected(day.date) && !day.outOfMonth ? 'hover:bg-accent' : '',
  ]
}
</script>

<template>
  <div ref="triggerRef">
    <!-- Single mode trigger -->
    <div v-if="mode === 'single'" class="flex flex-col gap-1.5">
      <label v-if="label" class="label-text">{{ label }}</label>
      <button
        type="button"
        class="input-field text-left flex items-center gap-2 cursor-pointer"
        :class="open ? 'ring-2 ring-primary/20 border-primary' : ''"
        @click="openPicker()"
      >
        <Calendar class="w-4 h-4 text-muted-foreground shrink-0" />
        <span :class="modelValue ? 'text-foreground' : 'text-muted-foreground'">{{ formatDisplay(modelValue) }}</span>
      </button>
    </div>

    <!-- Range mode trigger -->
    <div v-else class="flex gap-2 items-end">
      <div class="flex-1 flex flex-col gap-1.5">
        <label v-if="startLabel" class="label-text">{{ startLabel }}</label>
        <button
          type="button"
          class="input-field text-left flex items-center gap-2 cursor-pointer"
          :class="open && selecting === 'start' ? 'ring-2 ring-primary/20 border-primary' : ''"
          @click="openPicker('start')"
        >
          <Calendar class="w-4 h-4 text-muted-foreground shrink-0" />
          <span :class="modelStart ? 'text-foreground' : 'text-muted-foreground'">{{ formatDisplay(modelStart) }}</span>
        </button>
      </div>
      <div class="flex items-center h-10 px-2 text-muted-foreground text-sm">&rarr;</div>
      <div class="flex-1 flex flex-col gap-1.5">
        <label v-if="endLabel" class="label-text">{{ endLabel }}</label>
        <button
          type="button"
          class="input-field text-left flex items-center gap-2 cursor-pointer"
          :class="open && selecting === 'end' ? 'ring-2 ring-primary/20 border-primary' : ''"
          @click="openPicker('end')"
        >
          <Calendar class="w-4 h-4 text-muted-foreground shrink-0" />
          <span :class="modelEnd ? 'text-foreground' : 'text-muted-foreground'">{{ formatDisplay(modelEnd) }}</span>
        </button>
      </div>
    </div>

    <!-- Teleported Dropdown -->
    <Teleport to="body">
      <template v-if="open">
        <div class="fixed inset-0 z-[9998]" @click="closePicker"></div>
        <div
          class="fixed z-[9999] bg-card border border-border rounded-xl shadow-lg p-4"
          :style="dropdownPos"
          @mousedown.stop
        >
          <!-- Month nav -->
          <div class="flex items-center justify-between mb-3">
            <button type="button" class="p-1.5 rounded hover:bg-accent" @click="prevMonth">
              <ChevronLeft class="w-4 h-4 text-foreground" />
            </button>
            <div class="flex gap-8">
              <span class="text-sm font-semibold text-foreground w-[160px] text-center">{{ leftMonthLabel }}</span>
              <span v-if="showDualCalendar" class="text-sm font-semibold text-foreground w-[160px] text-center hidden sm:block">{{ rightMonthLabel }}</span>
            </div>
            <button type="button" class="p-1.5 rounded hover:bg-accent" @click="nextMonth">
              <ChevronRight class="w-4 h-4 text-foreground" />
            </button>
          </div>

          <div class="flex gap-6">
            <!-- Left calendar -->
            <div>
              <div class="grid grid-cols-7 gap-0 mb-1">
                <div v-for="d in weekDays" :key="d" class="w-9 h-7 flex items-center justify-center text-[10px] font-semibold text-muted-foreground uppercase">{{ d }}</div>
              </div>
              <div class="grid grid-cols-7 gap-0">
                <button
                  v-for="(day, i) in leftDays"
                  :key="'l' + i"
                  type="button"
                  class="w-9 h-9 flex items-center justify-center text-xs rounded-md transition-colors"
                  :class="dayClass(day)"
                  @click="selectDate(day.date)"
                  @mouseenter="hoverDate = day.date"
                  @mouseleave="hoverDate = ''"
                >{{ day.day }}</button>
              </div>
            </div>

            <!-- Right calendar (range mode only) -->
            <div v-if="showDualCalendar" class="hidden sm:block">
              <div class="grid grid-cols-7 gap-0 mb-1">
                <div v-for="d in weekDays" :key="d" class="w-9 h-7 flex items-center justify-center text-[10px] font-semibold text-muted-foreground uppercase">{{ d }}</div>
              </div>
              <div class="grid grid-cols-7 gap-0">
                <button
                  v-for="(day, i) in rightDays"
                  :key="'r' + i"
                  type="button"
                  class="w-9 h-9 flex items-center justify-center text-xs rounded-md transition-colors"
                  :class="dayClass(day)"
                  @click="selectDate(day.date)"
                  @mouseenter="hoverDate = day.date"
                  @mouseleave="hoverDate = ''"
                >{{ day.day }}</button>
              </div>
            </div>
          </div>

          <!-- Time picker -->
          <div v-if="showTime" class="mt-3 pt-3 border-t border-border">
            <!-- Single mode time -->
            <div v-if="mode === 'single'" class="flex items-center gap-2">
              <Clock class="w-3.5 h-3.5 text-muted-foreground" />
              <select class="input-field !w-16 !h-8 !px-2 text-xs text-center" v-model="singleHour" @change="onSingleTimeChange">
                <option v-for="h in hours" :key="h" :value="h">{{ h }}</option>
              </select>
              <span class="text-sm text-muted-foreground">:</span>
              <select class="input-field !w-16 !h-8 !px-2 text-xs text-center" v-model="singleMinute" @change="onSingleTimeChange">
                <option v-for="m in minutes" :key="m" :value="m">{{ m }}</option>
              </select>
            </div>
            <!-- Range mode times -->
            <div v-else class="flex flex-col gap-2">
              <div class="flex items-center gap-2">
                <span class="text-[10px] font-medium text-muted-foreground uppercase w-10">{{ t('from') }}</span>
                <select class="input-field !w-16 !h-8 !px-2 text-xs text-center" v-model="startHour" @change="onStartTimeChange">
                  <option v-for="h in hours" :key="h" :value="h">{{ h }}</option>
                </select>
                <span class="text-sm text-muted-foreground">:</span>
                <select class="input-field !w-16 !h-8 !px-2 text-xs text-center" v-model="startMinute" @change="onStartTimeChange">
                  <option v-for="m in minutes" :key="m" :value="m">{{ m }}</option>
                </select>
              </div>
              <div class="flex items-center gap-2">
                <span class="text-[10px] font-medium text-muted-foreground uppercase w-10">{{ t('to') }}</span>
                <select class="input-field !w-16 !h-8 !px-2 text-xs text-center" v-model="endHour" @change="onEndTimeChange">
                  <option v-for="h in hours" :key="h" :value="h">{{ h }}</option>
                </select>
                <span class="text-sm text-muted-foreground">:</span>
                <select class="input-field !w-16 !h-8 !px-2 text-xs text-center" v-model="endMinute" @change="onEndTimeChange">
                  <option v-for="m in minutes" :key="m" :value="m">{{ m }}</option>
                </select>
              </div>
            </div>
          </div>

          <!-- Footer -->
          <div class="flex items-center justify-between mt-3 pt-3 border-t border-border">
            <button type="button" class="text-xs text-muted-foreground hover:text-foreground transition-colors" @click="clearDates">{{ t('clear') }}</button>
            <button type="button" class="text-xs font-medium text-primary hover:text-primary/80 transition-colors" @click="closePicker">{{ t('close') }}</button>
          </div>
        </div>
      </template>
    </Teleport>
  </div>
</template>
