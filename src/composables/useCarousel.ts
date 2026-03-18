import { ref, watch, onUnmounted, nextTick, type Ref } from 'vue'

export function useCarousel(containerRef: Ref<HTMLElement | null>, speed = 0.5, itemCount: Ref<number>) {
  const isDragging = ref(false)
  let animId = 0
  let startX = 0
  let scrollLeft = 0
  let dragDelta = 0
  let bound = false
  let singleSetWidth = 0

  function measureSet() {
    const el = containerRef.value
    if (!el || itemCount.value === 0) return
    // Each item is 280px + 16px gap
    singleSetWidth = itemCount.value * (280 + 16)
  }

  function loopScroll(el: HTMLElement) {
    if (singleSetWidth <= 0) return
    if (el.scrollLeft >= singleSetWidth) {
      el.scrollLeft -= singleSetWidth
    } else if (el.scrollLeft <= 0) {
      el.scrollLeft += singleSetWidth
    }
  }

  function animate() {
    const el = containerRef.value
    if (!el) { animId = requestAnimationFrame(animate); return }
    if (!isDragging.value) {
      el.scrollLeft += speed
      loopScroll(el)
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
  }

  function onMouseMove(e: MouseEvent) {
    if (!isDragging.value) return
    const el = containerRef.value
    if (!el) return
    const dx = e.pageX - startX
    dragDelta = Math.abs(dx)
    el.scrollLeft = scrollLeft - dx
    loopScroll(el)
  }

  function onMouseUp() {
    if (!isDragging.value) return
    isDragging.value = false
    const el = containerRef.value
    if (el) el.style.cursor = 'grab'
  }

  function onClick(e: MouseEvent) {
    if (dragDelta > 5) {
      e.preventDefault()
      e.stopPropagation()
    }
  }

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
    loopScroll(el)
  }

  function onTouchEnd() { isDragging.value = false }

  function bind() {
    const el = containerRef.value
    if (!el || bound) return
    bound = true
    measureSet()
    el.style.cursor = 'grab'
    el.addEventListener('mousedown', onMouseDown)
    el.addEventListener('click', onClick, true)
    el.addEventListener('touchstart', onTouchStart, { passive: true })
    el.addEventListener('touchmove', onTouchMove, { passive: true })
    el.addEventListener('touchend', onTouchEnd)
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
    animId = requestAnimationFrame(animate)
  }

  function unbind() {
    if (animId) { cancelAnimationFrame(animId); animId = 0 }
    const el = containerRef.value
    if (el) {
      el.removeEventListener('mousedown', onMouseDown)
      el.removeEventListener('click', onClick, true)
      el.removeEventListener('touchstart', onTouchStart)
      el.removeEventListener('touchmove', onTouchMove)
      el.removeEventListener('touchend', onTouchEnd)
    }
    window.removeEventListener('mousemove', onMouseMove)
    window.removeEventListener('mouseup', onMouseUp)
    bound = false
  }

  watch(containerRef, (el) => {
    if (el) nextTick(bind)
    else unbind()
  }, { immediate: true })

  // Re-measure when item count changes
  watch(itemCount, () => {
    measureSet()
  })

  onUnmounted(unbind)

  return { isDragging }
}
