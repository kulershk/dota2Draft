import { ref, watch, onUnmounted, nextTick, type Ref } from 'vue'

export function useCarousel(containerRef: Ref<HTMLElement | null>, speed = 0.5) {
  const isDragging = ref(false)
  let animId = 0
  let startX = 0
  let scrollLeft = 0
  let dragDelta = 0
  let paused = false
  let bound = false

  function animate() {
    const el = containerRef.value
    if (!el) { animId = requestAnimationFrame(animate); return }
    if (!isDragging.value && !paused) {
      el.scrollLeft += speed
      // Loop: if scrolled past halfway (duplicated content), reset
      const half = el.scrollWidth / 2
      if (half > 0) {
        if (el.scrollLeft >= half) el.scrollLeft -= half
        else if (el.scrollLeft <= 0) el.scrollLeft += half
      }
    }
    animId = requestAnimationFrame(animate)
  }

  function onMouseDown(e: MouseEvent) {
    const el = containerRef.value
    if (!el) return
    e.preventDefault()
    isDragging.value = true
    dragDelta = 0
    startX = e.pageX
    scrollLeft = el.scrollLeft
    el.style.cursor = 'grabbing'
    el.style.userSelect = 'none'
  }

  function onMouseMove(e: MouseEvent) {
    if (!isDragging.value) return
    const el = containerRef.value
    if (!el) return
    const dx = e.pageX - startX
    dragDelta = Math.abs(dx)
    el.scrollLeft = scrollLeft - dx
    // Loop during drag
    const half = el.scrollWidth / 2
    if (half > 0) {
      if (el.scrollLeft >= half) el.scrollLeft -= half
      else if (el.scrollLeft <= 0) el.scrollLeft += half
    }
  }

  function onMouseUp() {
    isDragging.value = false
    const el = containerRef.value
    if (el) {
      el.style.cursor = 'grab'
      el.style.userSelect = ''
    }
  }

  // Prevent click on links if we dragged
  function onClick(e: MouseEvent) {
    if (dragDelta > 5) {
      e.preventDefault()
      e.stopPropagation()
    }
  }

  function onMouseEnter() { paused = true }
  function onMouseLeave() { paused = false; if (isDragging.value) onMouseUp() }

  // Touch support
  function onTouchStart(e: TouchEvent) {
    const el = containerRef.value
    if (!el) return
    isDragging.value = true
    dragDelta = 0
    startX = e.touches[0].pageX
    scrollLeft = el.scrollLeft
  }

  function onTouchMove(e: TouchEvent) {
    if (!isDragging.value) return
    const el = containerRef.value
    if (!el) return
    const dx = e.touches[0].pageX - startX
    dragDelta = Math.abs(dx)
    el.scrollLeft = scrollLeft - dx
  }

  function onTouchEnd() { isDragging.value = false }

  function bind() {
    const el = containerRef.value
    if (!el || bound) return
    bound = true
    el.style.cursor = 'grab'
    el.addEventListener('mousedown', onMouseDown)
    el.addEventListener('click', onClick, true)
    el.addEventListener('mouseenter', onMouseEnter)
    el.addEventListener('mouseleave', onMouseLeave)
    el.addEventListener('touchstart', onTouchStart, { passive: true })
    el.addEventListener('touchmove', onTouchMove, { passive: true })
    el.addEventListener('touchend', onTouchEnd)
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
    if (!animId) animId = requestAnimationFrame(animate)
  }

  function unbind() {
    cancelAnimationFrame(animId)
    animId = 0
    const el = containerRef.value
    if (!el) return
    el.removeEventListener('mousedown', onMouseDown)
    el.removeEventListener('click', onClick, true)
    el.removeEventListener('mouseenter', onMouseEnter)
    el.removeEventListener('mouseleave', onMouseLeave)
    el.removeEventListener('touchstart', onTouchStart)
    el.removeEventListener('touchmove', onTouchMove)
    el.removeEventListener('touchend', onTouchEnd)
    window.removeEventListener('mousemove', onMouseMove)
    window.removeEventListener('mouseup', onMouseUp)
    bound = false
  }

  // Watch for ref to become available (handles v-if timing)
  watch(containerRef, (el) => {
    if (el) nextTick(bind)
    else unbind()
  }, { immediate: true })

  onUnmounted(unbind)

  return { isDragging }
}
