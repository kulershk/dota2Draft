import { ref, watch, onUnmounted, nextTick, type Ref } from 'vue'

export function useCarousel(containerRef: Ref<HTMLElement | null>, speed = 0.5, itemCount: Ref<number>) {
  const isDragging = ref(false)
  const isHovering = ref(false)
  let animId = 0
  let startX = 0
  let dragStartOffset = 0
  let dragDelta = 0
  let bound = false
  let singleSetWidth = 0
  let offset = 0

  function measureSet() {
    const el = containerRef.value
    if (!el || itemCount.value === 0) { singleSetWidth = 0; return }
    const children = el.children
    if (children.length > 0 && itemCount.value > 0) {
      let width = 0
      for (let i = 0; i < itemCount.value && i < children.length; i++) {
        const child = children[i] as HTMLElement
        width += child.offsetWidth
      }
      const gap = parseFloat(getComputedStyle(el).gap || '0')
      width += gap * itemCount.value
      singleSetWidth = width
    }
  }

  function applyTransform() {
    const el = containerRef.value
    if (!el) return
    el.style.transform = `translateX(${-offset}px)`
  }

  function wrapOffset() {
    if (singleSetWidth <= 0) return
    while (offset >= singleSetWidth) offset -= singleSetWidth
    while (offset < 0) offset += singleSetWidth
  }

  function animate() {
    const el = containerRef.value
    if (!el) { animId = requestAnimationFrame(animate); return }
    if (!isDragging.value && !isHovering.value && singleSetWidth > 0) {
      offset += speed
      wrapOffset()
      applyTransform()
    }
    animId = requestAnimationFrame(animate)
  }

  function onMouseEnter() { isHovering.value = true }
  function onMouseLeave() { isHovering.value = false }

  function onMouseDown(e: MouseEvent) {
    const el = containerRef.value
    if (!el) return
    e.preventDefault()
    isDragging.value = true
    dragDelta = 0
    startX = e.pageX
    dragStartOffset = offset
    el.style.cursor = 'grabbing'
  }

  function onMouseMove(e: MouseEvent) {
    if (!isDragging.value) return
    const dx = e.pageX - startX
    dragDelta = Math.abs(dx)
    offset = dragStartOffset - dx
    wrapOffset()
    applyTransform()
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
    isDragging.value = true
    dragDelta = 0
    startX = e.touches[0].pageX
    dragStartOffset = offset
  }

  function onTouchMove(e: TouchEvent) {
    if (!isDragging.value) return
    const dx = e.touches[0].pageX - startX
    dragDelta = Math.abs(dx)
    offset = dragStartOffset - dx
    wrapOffset()
    applyTransform()
  }

  function onTouchEnd() { isDragging.value = false }

  function bind() {
    const el = containerRef.value
    if (!el || bound) return
    bound = true
    measureSet()
    el.style.cursor = 'grab'
    el.addEventListener('mousedown', onMouseDown)
    el.addEventListener('mouseenter', onMouseEnter)
    el.addEventListener('mouseleave', onMouseLeave)
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
      el.removeEventListener('mouseenter', onMouseEnter)
      el.removeEventListener('mouseleave', onMouseLeave)
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

  watch(itemCount, () => {
    nextTick(() => {
      measureSet()
      if (!bound && containerRef.value) bind()
    })
  })

  onUnmounted(unbind)

  return { isDragging }
}
