export function ditherBlur({
  height = '25vh', // band height (any CSS length)
  dot = 3,         // dither cell, css px
  blur = 40,       // max blur radius at the bottom edge, css px
  levels = 4,      // colour levels per channel at the bottom edge (32 at the top)
  stopAt = 'footer', // selector: never drawn over, left out of the snapshot, effect fades out when it's in view
} = {}) {
  const fx = document.createElement('canvas');
  fx.className = 'dither-blur';
  fx.setAttribute('aria-hidden', 'true');
  fx.style.cssText = `position:fixed;left:0;bottom:0;width:100%;height:${height};z-index:10;pointer-events:none`;
  document.body.append(fx);

  const gl = fx.getContext('webgl2');
  if (!gl) { fx.remove(); return { refresh() { }, destroy() { } }; }

  const f = n => n.toFixed(3); // JS number -> GLSL float literal
  const FS = `#version 300 es
  precision highp float;
  uniform sampler2D uPage;
  uniform vec2 uPageSize;    // snapshot size, css px
  uniform float uTop, uH, uDpr, uScale, uK, uStop; // uStop: page y of the stopAt element, css px
  out vec4 o;
  const float B[16] = float[](0.,8.,2.,10., 12.,4.,14.,6., 3.,11.,1.,9., 15.,7.,13.,5.);
  void main() {
    vec2 css = vec2(gl_FragCoord.x, uH * uDpr - gl_FragCoord.y) / uDpr; // y down, css px inside the band
    vec2 cell = floor(css / ${f(dot)});            // dither grid
    float t = clamp(css.y / uH, 0., 1.);           // 0 top of band .. 1 bottom
    float r = ${f(blur)} * t * t;                  // blur radius grows down the band
    if (uTop + css.y >= uStop) { o = vec4(0); return; }
    vec2 uv = vec2(css.x, uTop + css.y) / uPageSize;

    // blur: 9 taps on a mip level matching the radius
    float lod = log2(max(r * uScale, 1.));
    vec3 c = textureLod(uPage, uv, lod).rgb;
    for (int i = 0; i < 8; i++) {
      float a = float(i) * .785398;
      c += textureLod(uPage, uv + vec2(cos(a), sin(a)) * r / uPageSize, lod).rgb;
    }
    c /= 9.;

    // ordered dither: 32 levels at the top (invisible seam) down to \`levels\` at the bottom
    float L = floor(exp2(mix(5., ${f(Math.log2(levels))}, t)) + .5) - 1.;
    float th = (B[int(mod(cell.y, 4.)) * 4 + int(mod(cell.x, 4.))] + .5) / 16.;
    c = floor(c * L + th) / L;

    o = vec4(c * uK, uK);
  }`;

  const prog = gl.createProgram();
  for (const [type, src] of [
    [gl.VERTEX_SHADER, `#version 300 es
      void main() { gl_Position = vec4(vec2(gl_VertexID & 1, gl_VertexID >> 1) * 4. - 1., 0, 1); }`], // fullscreen triangle
    [gl.FRAGMENT_SHADER, FS]]) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw gl.getShaderInfoLog(s);
    gl.attachShader(prog, s);
  }
  gl.linkProgram(prog); gl.useProgram(prog);
  const U = Object.fromEntries(['uPageSize', 'uTop', 'uH', 'uDpr', 'uScale', 'uK', 'uStop'].map(n => [n, gl.getUniformLocation(prog, n)]));

  gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  // snapshot: serialize the DOM into an SVG <foreignObject> and decode it as an image.
  async function snapshot() {
    const w = document.documentElement.clientWidth, h = document.documentElement.scrollHeight;
    const max = gl.getParameter(gl.MAX_TEXTURE_SIZE), scale = Math.min(devicePixelRatio, max / w, max / h);
    const clone = document.documentElement.cloneNode(true);
    clone.querySelectorAll('script, .dither-blur' + (stopAt ? ', ' + stopAt : '')).forEach(n => n.remove());
    clone.style.height = h + 'px'; // keep the bg painted where the stopAt element was
    const img = new Image();
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.floor(w * scale)}" height="${Math.floor(h * scale)}" viewBox="0 0 ${w} ${h}"` +
      ` style="font-size:${getComputedStyle(document.documentElement).fontSize}">` + // <svg> is the root in there, so rem resolves against it
      `<foreignObject width="${w}" height="${h}">${new XMLSerializer().serializeToString(clone)}</foreignObject></svg>`);
    await img.decode();
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.uniform2f(U.uPageSize, w, h);
    gl.uniform1f(U.uScale, scale);
    const stop = stopAt && document.querySelector(stopAt);
    gl.uniform1f(U.uStop, stop ? stop.getBoundingClientRect().top + scrollY : 1e9);
  }

  let bandTop = 0;
  function size() {
    const r = fx.getBoundingClientRect();
    fx.width = Math.round(r.width * devicePixelRatio);
    fx.height = Math.round(r.height * devicePixelRatio);
    gl.viewport(0, 0, fx.width, fx.height);
    gl.uniform1f(U.uH, r.height);
    gl.uniform1f(U.uDpr, devicePixelRatio);
    bandTop = r.top;
  }

  let off = false, k = 1, raf, timer;
  const io = new IntersectionObserver(([e]) => off = e.isIntersecting);
  const stopEl = stopAt && document.querySelector(stopAt);
  if (stopEl) io.observe(stopEl);

  // renders every frame; switch to render-on-scroll if battery matters
  function frame() {
    k += ((off ? 0 : 1) - k) * .12;
    gl.uniform1f(U.uK, k);
    gl.uniform1f(U.uTop, scrollY + bandTop);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    raf = requestAnimationFrame(frame);
  }

  function onResize() { size(); clearTimeout(timer); timer = setTimeout(snapshot, 200); }
  addEventListener('resize', onResize);
  size();
  document.fonts.ready.then(snapshot).then(() => fx.isConnected && frame()); // skip if destroyed meanwhile

  return {
    refresh: snapshot,
    destroy() {
      cancelAnimationFrame(raf); clearTimeout(timer); io.disconnect();
      removeEventListener('resize', onResize);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
      fx.remove();
    },
  };
}
