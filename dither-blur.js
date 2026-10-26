// Needs dither-blur.css. stopAt: selector never drawn over; the effect fades out once it's in view.
export function ditherBlur({ stopAt = 'footer' } = {}) {
  // flat siblings on <body>, no wrapper: a wrapper gets isolated by the blend layer and backdrop-filter would only see the wrapper
  const layers = ['b0', 'b1', 'b2', 'b3', 'b4', 'b5', 'pattern', 'snap'].map(c => {
    const l = document.createElement('div');
    l.className = 'dither-blur ' + c;
    l.setAttribute('aria-hidden', 'true');
    return l;
  });
  document.body.append(...layers);

  // clip at the stopAt element's top edge, fade out once it's in view
  const stopEl = stopAt && document.querySelector(stopAt);
  const io = new IntersectionObserver(([e]) => {
    for (const l of layers) l.style.opacity = e.isIntersecting ? 0 : 1;
  });
  function clip() {
    const cut = Math.max(0, innerHeight - stopEl.getBoundingClientRect().top);
    for (const l of layers) l.style.clipPath = `inset(0 0 ${cut}px 0)`;
  }
  if (stopEl) {
    io.observe(stopEl);
    addEventListener('scroll', clip, { passive: true });
    addEventListener('resize', clip);
    clip();
  }

  return {
    destroy() {
      io.disconnect();
      removeEventListener('scroll', clip);
      removeEventListener('resize', clip);
      for (const l of layers) l.remove();
    },
  };
}
