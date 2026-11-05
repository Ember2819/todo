// Ordered dithering, after the dithercn engine (https://dithercn.dev):
// Bayer threshold maps, CSS masks built from them, a WebGL horizon that
// lives in the empty space under the list, and a small dithered burst.

// Bayer ranks: interleave the bits of (x xor y) and y, least significant
// first, so each 2x2 block of the previous size splits into four.
const bayerRanks = (size) => {
  const ranks = new Uint8Array(size * size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let rank = 0;
      for (let bit = 1; bit < size; bit *= 2) {
        const xBit = Math.floor(x / bit) % 2;
        const yBit = Math.floor(y / bit) % 2;
        rank = rank * 4 + 2 * ((xBit + yBit) % 2) + yBit;
      }
      ranks[y * size + x] = rank;
    }
  }
  return ranks;
};

const fromRanks = (size) => {
  const ranks = bayerRanks(size);
  const steps = size * size;
  return { size, steps, thresholds: Float32Array.from(ranks, (r) => (r + 0.5) / steps) };
};

export const MATRICES = { bayer4: fromRanks(4), bayer8: fromRanks(8) };
const matrixOf = (name) => MATRICES[name] ?? MATRICES.bayer8;

// --- CSS masks ---------------------------------------------------------------

const cellsPath = (width, height, inked) => {
  let path = "";
  for (let y = 0; y < height; y += 1) {
    let start = -1;
    for (let x = 0; x <= width; x += 1) {
      const on = x < width && inked(x, y);
      if (on && start === -1) start = x;
      else if (!on && start !== -1) {
        path += `M${start} ${y}h${x - start}v1h${start - x}z`;
        start = -1;
      }
    }
  }
  return path;
};

const svgUrl = (width, height, path) => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" shape-rendering="crispEdges"><path d="${path}"/></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
};

const levelMask = (level, matrix) => {
  const { size, thresholds } = matrixOf(matrix);
  return svgUrl(size, size, cellsPath(size, size, (x, y) => level > thresholds[y * size + x]));
};

/** Coverage falling from `from` at the left to `to` at the right over `length` cells. */
const rampMask = (length, from, to, matrix) => {
  const { size, thresholds } = matrixOf(matrix);
  const width = Math.ceil(length / size) * size;
  const levelAt = (x) => from + (to - from) * ((x + 0.5) / width);
  return { width, url: svgUrl(width, size, cellsPath(width, size, (x, y) => levelAt(x) > thresholds[(y % size) * size + (x % size)])) };
};

/** CSS variables for the dithered meter. */
export const installDitherStyles = (matrix) => {
  const { size } = matrixOf(matrix);
  const ramp = rampMask(16, 1, 0, matrix);
  const vars = {
    "--dm-size": size,
    "--dm-track": levelMask(0.25, matrix),
    "--dm-ramp": ramp.url,
    "--dm-ramp-w": ramp.width,
  };
  for (const [key, value] of Object.entries(vars)) document.documentElement.style.setProperty(key, String(value));
};

// --- Horizon -----------------------------------------------------------------

const VERT = `attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}`;

// A planet's edge seen from orbit: a bright rim, a glow that drifts above
// it, and a few slow stars. `u_top` is where the rim peaks and `u_ceil`
// where the free space ends, both in pixels from the bottom; nothing is
// drawn above the ceiling, so the dots never sit behind text.
const FRAG = `
precision highp float;
uniform vec2 u_res;
uniform float u_cell;
uniform float u_dpr;
uniform float u_time;
uniform float u_size;
uniform float u_top;
uniform float u_ceil;
uniform vec3 u_ink;
uniform sampler2D u_matrix;

float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
float noise(vec2 p){
  vec2 i=floor(p);vec2 f=fract(p);
  vec2 u=f*f*(3.-2.*f);
  return mix(mix(hash(i),hash(i+vec2(1.,0.)),u.x),mix(hash(i+vec2(0.,1.)),hash(i+vec2(1.,1.)),u.x),u.y);
}
float fbm(vec2 p){float v=0.;float a=.5;for(int i=0;i<4;i++){v+=a*noise(p);p*=2.03;a*=.5;}return v;}

void main(){
  vec2 cell=floor(gl_FragCoord.xy/u_cell);
  vec2 p=(cell+.5)*u_cell;
  float W=u_res.x;
  float R=W*1.15;
  vec2 q=p-vec2(W*.5,u_top-R);
  float d=length(q)-R;
  float a=atan(q.x,q.y);
  float H=110.*u_dpr;

  float rim=exp(-pow(d/(3.5*u_dpr),2.));
  float drift=fbm(vec2(a*7.+u_time*.04,d/(H*.45)-u_time*.06));
  float halo=d>0.?exp(-d/(H*.3))*(.45+.75*drift):exp(d/(5.*u_dpr))*.6;
  // Drop the faintest tones: a lone dot every few cells reads as a grid, not as glow.
  float tone=clamp((rim*.9+halo*.7-.05)/.95,0.,1.);

  float h=hash(cell);
  float star=step(.9975,h)*step(.55,.5+.5*sin(u_time*.5+h*80.));
  tone=max(tone,star*step(0.,d-12.*u_dpr));

  tone*=1.-smoothstep(u_ceil-28.*u_dpr,u_ceil,p.y);
  float threshold=texture2D(u_matrix,(mod(cell,u_size)+.5)/u_size).r;
  gl_FragColor=tone>threshold?vec4(u_ink,1.):vec4(0.);
}`;

export class Horizon {
  constructor(canvas) {
    this.canvas = canvas;
    this.start = performance.now() - 40000 * Math.random();
    this.top = -1000;
    this.targetTop = -1000;
    this.ceil = 0;
    this.cell = 2;
    this.animate = true;
    this.running = false;
    const gl = canvas.getContext("webgl", { premultipliedAlpha: true, antialias: false, alpha: true });
    this.gl = gl;
    if (!gl) return;
    const shader = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) console.error(gl.getShaderInfoLog(s));
      return s;
    };
    const program = gl.createProgram();
    gl.attachShader(program, shader(gl.VERTEX_SHADER, VERT));
    gl.attachShader(program, shader(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(program);
    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(program, "p");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    this.u = Object.fromEntries(
      ["u_res", "u_cell", "u_dpr", "u_time", "u_size", "u_top", "u_ceil", "u_ink", "u_matrix"].map((n) => [n, gl.getUniformLocation(program, n)]),
    );
    this.texture = gl.createTexture();
    new ResizeObserver(() => this.resize()).observe(canvas);
    document.addEventListener("visibilitychange", () => (document.hidden ? this.stop() : this.play()));
  }

  setMatrix(name) {
    const { gl } = this;
    if (!gl || name === this.matrix) return;
    this.matrix = name;
    const { size, thresholds } = matrixOf(name);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, size, size, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, Uint8Array.from(thresholds, (t) => Math.round(t * 255)));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.uniform1f(this.u.u_size, size);
  }

  configure({ matrix, cell, animate, ink }) {
    this.setMatrix(matrix);
    this.cell = cell;
    this.ink = ink;
    this.animate = animate;
    this.resize();
    if (animate) this.play();
    else {
      this.stop();
      this.top = this.targetTop;
      this.draw();
    }
  }

  /** The free space under the content, in CSS pixels from the bottom of the canvas. */
  setSpace(free) {
    const dpr = window.devicePixelRatio || 1;
    this.ceil = free * dpr;
    // The rim sits a little under halfway up the free space; with no room it sets below the edge.
    this.targetTop = free < 90 ? -40 * dpr : Math.min(free * 0.46, 220) * dpr;
    if (this.top < -500 * dpr) this.top = this.animate ? -40 * dpr : this.targetTop;
    if (!this.animate) {
      this.top = this.targetTop;
      this.draw();
    }
    this.play();
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.draw();
  }

  draw(now = performance.now()) {
    const { gl, u } = this;
    if (!gl || !this.ink) return;
    const dpr = window.devicePixelRatio || 1;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.uniform2f(u.u_res, this.canvas.width, this.canvas.height);
    gl.uniform1f(u.u_cell, Math.max(1, Math.round(this.cell * dpr)));
    gl.uniform1f(u.u_dpr, dpr);
    gl.uniform1f(u.u_time, this.animate ? (now - this.start) / 1000 : 30);
    gl.uniform1f(u.u_top, this.top);
    gl.uniform1f(u.u_ceil, this.ceil);
    gl.uniform3fv(u.u_ink, this.ink);
    gl.uniform1i(u.u_matrix, 0);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  play() {
    if (this.running || !this.animate || !this.gl || document.hidden) return;
    this.running = true;
    let last = performance.now();
    const tick = (now) => {
      if (!this.running) return;
      if (now - last >= 33) {
        const dt = Math.min(0.1, (now - last) / 1000);
        // Ease toward the target height, so the rim glides as the list changes.
        this.top += (this.targetTop - this.top) * (1 - Math.exp(-dt * 4));
        this.draw(now);
        last = now;
      }
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }
}

// --- Burst -------------------------------------------------------------------

/**
 * A dithered ring that blooms out of a point and thins away, drawn on a
 * throwaway 2D canvas. Used when a task is completed.
 */
export const burst = (host, x, y, { ink, cell = 2, matrix = "bayer8", duration = 620 }) => {
  const radius = 24;
  const dpr = window.devicePixelRatio || 1;
  const px = Math.max(1, Math.round(cell * dpr));
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = Math.round(radius * 2 * dpr);
  Object.assign(canvas.style, {
    position: "absolute",
    left: `${x - radius}px`,
    top: `${y - radius}px`,
    width: `${radius * 2}px`,
    height: `${radius * 2}px`,
    pointerEvents: "none",
    zIndex: "6",
  });
  canvas.setAttribute("aria-hidden", "true");
  host.append(canvas);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = `rgb(${ink.map((c) => Math.round(c * 255)).join(" ")})`;
  const { size: m, thresholds } = matrixOf(matrix);
  const cells = Math.ceil(canvas.width / px);
  const center = canvas.width / 2;
  const start = performance.now();
  const frame = (now) => {
    const t = Math.min(1, (now - start) / duration);
    const ease = 1 - (1 - t) ** 3;
    const r = (7 + 13 * ease) * dpr;
    const width = (1.8 + 4 * (1 - ease)) * dpr;
    const strength = (1 - t) ** 1.5;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (let cy = 0; cy < cells; cy += 1) {
      for (let cx = 0; cx < cells; cx += 1) {
        const d = Math.hypot((cx + 0.5) * px - center, (cy + 0.5) * px - center) - r;
        const tone = Math.exp(-((d / width) ** 2)) * strength;
        if (tone > thresholds[(cy % m) * m + (cx % m)]) ctx.fillRect(cx * px, cy * px, px, px);
      }
    }
    if (t < 1) requestAnimationFrame(frame);
    else canvas.remove();
  };
  requestAnimationFrame(frame);
};
