/* KÄLTE — particle scroll story
 *
 * The jacket is the real product photo (four angles from the tech pack).
 * Every view is also sampled into ~26k particles; scrolling between sections
 * dissolves the current photo into particles, morphs them into the next
 * angle, and re-materialises the photo there. Hovering the jacket scatters
 * particles out of the photo under the cursor. A plexus of drifting nodes
 * and connecting lines fills the background.
 */
(() => {
  const V = THREE.Vector3;
  const lerp = (a, b, t) => a + (b - a) * t;
  const clamp01 = (x) => Math.min(1, Math.max(0, x));
  const smoothstep = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
  const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const finePointer = matchMedia("(hover: hover) and (pointer: fine)").matches;
  const isMobile = () => window.innerWidth <= 820;

  const loader = document.querySelector(".loader");
  if (location.protocol === "file:") {
    loader.querySelector(".loader-count").innerHTML =
      "Open this site through a local server:<br><code>python3 -m http.server</code> → http://localhost:8000";
    loader.querySelector(".loader-count").style.cssText = "text-align:center;line-height:1.8;letter-spacing:0";
    return;
  }

  gsap.registerPlugin(ScrollTrigger);

  /* ------------------------------------------------------------------ */
  /* Renderer                                                            */
  /* ------------------------------------------------------------------ */
  const canvas = document.getElementById("webgl");
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "high-performance" });
  const DPR = Math.min(window.devicePixelRatio, 2);
  renderer.setPixelRatio(DPR);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100);
  camera.position.set(0, 0, 10);

  const JH = 5; // world height of every jacket view

  /* ------------------------------------------------------------------ */
  /* Assets                                                              */
  /* ------------------------------------------------------------------ */
  const VIEW_NAMES = ["front", "left", "right", "back"];
  const SEQ = [0, 1, 2, 3, 0]; // view shown at each morph slot (slot 4 = front again for the shop)

  const countEl = loader.querySelector(".loader-count span");
  const barEl = loader.querySelector(".loader-bar span");
  let loaded = 0;
  const loadImage = (src) =>
    new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        loaded++;
        const pct = Math.round((loaded / VIEW_NAMES.length) * 100);
        countEl.textContent = pct;
        barEl.style.width = pct + "%";
        resolve(img);
      };
      img.onerror = reject;
      img.src = src;
    });

  /* ------------------------------------------------------------------ */
  /* Shaders                                                             */
  /* ------------------------------------------------------------------ */
  const GLSL_COMMON = /* glsl */ `
    float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    float noise(vec2 p) {
      vec2 i = floor(p), f = fract(p);
      vec2 u = f * f * (3.0 - 2.0 * f);
      return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
                 mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
    }
    // recolour only the light, unsaturated panels; black panels stay black
    vec3 tintify(vec3 c, vec3 t) {
      float l = dot(c, vec3(0.299, 0.587, 0.114));
      float s = max(max(c.r, c.g), c.b) - min(min(c.r, c.g), c.b);
      float m = smoothstep(0.42, 0.72, l) * (1.0 - smoothstep(0.06, 0.2, s));
      return mix(c, c * t, m);
    }
  `;

  const IMAGE_VERT = /* glsl */ `
    varying vec2 vUv;
    varying vec2 vPos;
    void main() {
      vUv = uv;
      vPos = position.xy;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `;

  const IMAGE_FRAG = /* glsl */ `
    uniform sampler2D map;
    uniform float uVis;
    uniform vec3 uTint;
    uniform vec2 uMouse;
    uniform float uHover;
    uniform float uRadius;
    varying vec2 vUv;
    varying vec2 vPos;
    ${GLSL_COMMON}
    void main() {
      vec4 tex = texture2D(map, vUv);
      if (tex.a < 0.02) discard;
      vec3 col = tintify(tex.rgb, uTint);

      // noisy top-to-bottom wipe; glowing ice-blue line on the dissolve front
      float n = noise(vPos * 6.0) * 0.65 + noise(vPos * 22.0) * 0.35;
      float wipe = mix(n, vUv.y, 0.5);
      float th = (1.0 - uVis) * 1.12 - 0.06;
      float edge = wipe - th;
      if (edge < 0.0) discard;
      float glow = (1.0 - smoothstep(0.0, 0.05, edge)) * step(0.002, 1.0 - uVis);

      // hover: punch a soft noisy hole under the cursor (particles fill it)
      float d = distance(vPos, uMouse);
      float hole = (1.0 - smoothstep(uRadius * 0.5, uRadius, d + (n - 0.5) * 0.3)) * uHover;
      float rim = hole * (1.0 - hole) * 4.0;
      float a = tex.a * (1.0 - hole);
      if (a < 0.02) discard;

      col += vec3(0.62, 0.76, 1.0) * (glow * 1.3 + rim * 0.55);
      gl_FragColor = vec4(col, a);
    }
  `;

  const PARTICLE_VERT = /* glsl */ `
    attribute vec3 aA;
    attribute vec3 aB;
    attribute vec3 aCA;
    attribute vec3 aCB;
    attribute vec4 aR;
    uniform float uF;
    uniform float uEx;
    uniform float uPulse;
    uniform float uTime;
    uniform float uSize;
    uniform float uHover;
    uniform float uRadius;
    uniform vec2 uMouse;
    uniform vec3 uTint;
    varying vec3 vCol;
    varying float vA;
    ${GLSL_COMMON}
    void main() {
      float k = uF * uF * (3.0 - 2.0 * uF);
      vec3 p = mix(aA, aB, k);

      // mid-morph scatter + swirl
      float burst = sin(3.14159 * uF) + uPulse;
      vec3 dir = normalize(aR.xyz - 0.5 + 0.0001);
      // keep the scatter tight so the jacket silhouette stays readable mid-morph
      p += dir * burst * (0.1 + aR.w * 0.38);
      p.x += sin(uTime * 0.9 + aR.y * 20.0) * 0.06 * burst;
      p.y += cos(uTime * 0.8 + aR.x * 20.0) * 0.06 * burst;

      // full explode into a drifting cloud
      vec3 cloud = (aR.xyz - 0.5) * vec3(24.0, 14.0, 10.0);
      cloud.x += sin(uTime * 0.15 + aR.w * 6.283) * 0.7;
      cloud.y += cos(uTime * 0.12 + aR.z * 6.283) * 0.7;
      float ex = uEx * uEx * (3.0 - 2.0 * uEx);
      p = mix(p, cloud, ex);

      // hover: push particles away from the cursor
      vec2 d = p.xy - uMouse;
      float h = (1.0 - smoothstep(uRadius * 0.25, uRadius * 1.15, length(d))) * uHover * (1.0 - ex);
      p.xy += normalize(d + 0.0001) * h * (0.15 + aR.w * 0.6);
      p.z += h * (aR.x - 0.2) * 1.4;

      float vis = smoothstep(0.0, 0.1, uF) * (1.0 - smoothstep(0.9, 1.0, uF));
      vA = clamp(max(max(vis, uPulse), max(ex * 0.7, h * 1.3)), 0.0, 1.0);

      // dark fabric becomes violet-blue light so it reads on the dark page
      vec3 raw = tintify(mix(aCA, aCB, k), uTint);
      float l = dot(raw, vec3(0.299, 0.587, 0.114));
      vCol = mix(vec3(0.36, 0.42, 1.0), raw * 1.05, smoothstep(0.1, 0.7, l));

      vec4 mv = modelViewMatrix * vec4(p, 1.0);
      gl_Position = projectionMatrix * mv;
      gl_PointSize = vA < 0.01 ? 0.0 : uSize * (0.45 + aR.w) * (10.0 / -mv.z);
    }
  `;

  const PARTICLE_FRAG = /* glsl */ `
    varying vec3 vCol;
    varying float vA;
    void main() {
      float d = length(gl_PointCoord - 0.5);
      if (d > 0.5) discard;
      gl_FragColor = vec4(vCol, smoothstep(0.5, 0.05, d) * vA);
    }
  `;

  /* ------------------------------------------------------------------ */
  /* Jacket: photo planes + particles (built after images load)          */
  /* ------------------------------------------------------------------ */
  const jacket = new THREE.Group();
  scene.add(jacket);

  const shared = {
    uTint: { value: new THREE.Color(1, 1, 1) },
    uMouse: { value: new THREE.Vector2(99, 99) },
    uHover: { value: 0 },
    uRadius: { value: 0.75 },
    uTime: { value: 0 },
  };

  let planes = [];
  let views = [];
  let particles, pUniforms, pGeo;
  const PCOUNT = isMobile() ? 12000 : 26000;

  // Sample a view into N particle positions + colours (in the plane's local space)
  function sampleView(img, n) {
    const cw = 260;
    const ch = Math.round((img.height / img.width) * cw);
    const c = document.createElement("canvas");
    c.width = cw; c.height = ch;
    const g = c.getContext("2d", { willReadFrequently: true });
    g.drawImage(img, 0, 0, cw, ch);
    const data = g.getImageData(0, 0, cw, ch).data;
    const cand = [];
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) if (data[(y * cw + x) * 4 + 3] > 150) cand.push(x, y);

    const W = JH * (img.width / img.height);
    const pts = [];
    for (let i = 0; i < n; i++) {
      const k = (Math.random() * (cand.length / 2)) | 0;
      const px = cand[k * 2], py = cand[k * 2 + 1];
      const o = (py * cw + px) * 4;
      pts.push({
        x: ((px + Math.random()) / cw - 0.5) * W,
        y: (0.5 - (py + Math.random()) / ch) * JH,
        z: (Math.random() - 0.5) * 0.12,
        r: data[o] / 255, g: data[o + 1] / 255, b: data[o + 2] / 255,
      });
    }
    // sort in rows so particle i lands in a similar place in every view
    pts.sort((a, b) => Math.round(b.y * 14) - Math.round(a.y * 14) || a.x - b.x);
    const pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
    pts.forEach((p, i) => {
      pos.set([p.x, p.y, p.z], i * 3);
      col.set([p.r, p.g, p.b], i * 3);
    });
    return { pos, col, W };
  }

  function buildJacket(images) {
    views = images.map((img) => sampleView(img, PCOUNT));

    planes = SEQ.map((vi, slot) => {
      const tex = new THREE.Texture(images[vi]);
      tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
      tex.needsUpdate = true;
      const mat = new THREE.ShaderMaterial({
        uniforms: { map: { value: tex }, uVis: { value: 0 }, ...shared },
        vertexShader: IMAGE_VERT,
        fragmentShader: IMAGE_FRAG,
        transparent: true,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(views[vi].W, JH), mat);
      mesh.renderOrder = 1;
      mesh.visible = false;
      jacket.add(mesh);
      return mesh;
    });

    pGeo = new THREE.BufferGeometry();
    const r = new Float32Array(PCOUNT * 4);
    for (let i = 0; i < r.length; i++) r[i] = Math.random();
    pGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(PCOUNT * 3), 3));
    pGeo.setAttribute("aA", new THREE.BufferAttribute(new Float32Array(views[0].pos), 3));
    pGeo.setAttribute("aB", new THREE.BufferAttribute(new Float32Array(views[1].pos), 3));
    pGeo.setAttribute("aCA", new THREE.BufferAttribute(new Float32Array(views[0].col), 3));
    pGeo.setAttribute("aCB", new THREE.BufferAttribute(new Float32Array(views[1].col), 3));
    pGeo.setAttribute("aR", new THREE.BufferAttribute(r, 4));
    pGeo.boundingSphere = new THREE.Sphere(new V(), 50);

    pUniforms = {
      ...shared,
      uF: { value: 0 },
      uEx: { value: 1 },
      uPulse: { value: 0 },
      uSize: { value: 2.7 * DPR },
    };
    particles = new THREE.Points(pGeo, new THREE.ShaderMaterial({
      uniforms: pUniforms,
      vertexShader: PARTICLE_VERT,
      fragmentShader: PARTICLE_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
    }));
    particles.renderOrder = 2;
    jacket.add(particles);
  }

  let curSeg = 0;
  function setSegment(i) {
    if (i === curSeg) return;
    curSeg = i;
    const a = views[SEQ[i]], b = views[SEQ[i + 1]];
    pGeo.attributes.aA.array.set(a.pos);
    pGeo.attributes.aB.array.set(b.pos);
    pGeo.attributes.aCA.array.set(a.col);
    pGeo.attributes.aCB.array.set(b.col);
    ["aA", "aB", "aCA", "aCB"].forEach((k) => (pGeo.attributes[k].needsUpdate = true));
  }

  /* ---------- Display ring (shop) ---------- */
  const ring = new THREE.Group();
  (function buildRing() {
    const c = document.createElement("canvas");
    c.width = c.height = 256;
    const g = c.getContext("2d");
    const grad = g.createRadialGradient(128, 128, 0, 128, 128, 128);
    grad.addColorStop(0, "rgba(170,190,255,0.55)");
    grad.addColorStop(0.5, "rgba(130,120,255,0.15)");
    grad.addColorStop(1, "rgba(130,120,255,0)");
    g.fillStyle = grad;
    g.fillRect(0, 0, 256, 256);
    const pool = new THREE.Mesh(
      new THREE.PlaneGeometry(6, 6),
      new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending })
    );
    pool.rotation.x = -Math.PI / 2;
    const band = new THREE.Mesh(
      new THREE.RingGeometry(2.0, 2.035, 160),
      new THREE.MeshBasicMaterial({ color: 0xcfe0ff, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide })
    );
    band.rotation.x = -Math.PI / 2;

    const N = 700;
    const pos = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      const a = Math.random() * Math.PI * 2;
      const rr = 2.0 + (Math.random() - 0.5) * 0.35;
      pos.set([Math.cos(a) * rr, (Math.random() - 0.5) * 0.08, Math.sin(a) * rr], i * 3);
    }
    const orbitGeo = new THREE.BufferGeometry();
    orbitGeo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    const orbit = new THREE.Points(orbitGeo, new THREE.PointsMaterial({
      color: 0xbfd2ff, size: 0.035, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    ring.add(pool, band, orbit);
    ring.userData = { pool, band, orbit };
  })();
  ring.position.y = -JH / 2 + 0.02;
  ring.visible = false;
  jacket.add(ring);

  /* ---------- Plexus: drifting nodes joined by lines ---------- */
  const plexus = new THREE.Group();
  const PN = isMobile() ? 46 : 96;
  const LINK = 2.6;
  const MAXL = PN * 12;
  const nodePos = new Float32Array(PN * 3);
  const nodeVel = new Float32Array(PN * 3);
  for (let i = 0; i < PN; i++) {
    nodePos.set([(Math.random() - 0.5) * 22, (Math.random() - 0.5) * 13, -2 - Math.random() * 6], i * 3);
    nodeVel.set([(Math.random() - 0.5) * 0.25, (Math.random() - 0.5) * 0.25, (Math.random() - 0.5) * 0.05], i * 3);
  }
  const nodeGeo = new THREE.BufferGeometry();
  nodeGeo.setAttribute("position", new THREE.BufferAttribute(nodePos, 3));
  const nodes = new THREE.Points(nodeGeo, new THREE.PointsMaterial({
    color: 0xc4d6ff, size: 0.06, transparent: true, opacity: 0.8, depthWrite: false, blending: THREE.AdditiveBlending,
  }));
  const linePos = new Float32Array(MAXL * 6);
  const lineCol = new Float32Array(MAXL * 6);
  const lineGeo = new THREE.BufferGeometry();
  lineGeo.setAttribute("position", new THREE.BufferAttribute(linePos, 3));
  lineGeo.setAttribute("color", new THREE.BufferAttribute(lineCol, 3));
  const lines = new THREE.LineSegments(lineGeo, new THREE.LineBasicMaterial({
    vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  }));
  lines.frustumCulled = nodes.frustumCulled = false;
  plexus.add(lines, nodes);
  scene.add(plexus);

  /* ---------- Frost dust ---------- */
  const DUST = reduceMotion ? 150 : 380;
  const dustPos = new Float32Array(DUST * 3);
  const dustSpd = new Float32Array(DUST);
  for (let i = 0; i < DUST; i++) {
    dustPos.set([(Math.random() - 0.5) * 22, (Math.random() - 0.5) * 13, -4 + Math.random() * 7], i * 3);
    dustSpd[i] = 0.12 + Math.random() * 0.3;
  }
  const dustGeo = new THREE.BufferGeometry();
  dustGeo.setAttribute("position", new THREE.BufferAttribute(dustPos, 3));
  const dust = new THREE.Points(dustGeo, new THREE.PointsMaterial({
    color: 0xffffff, size: 0.03, transparent: true, opacity: 0.55, depthWrite: false, blending: THREE.AdditiveBlending,
  }));
  dust.frustumCulled = false;
  scene.add(dust);

  /* ------------------------------------------------------------------ */
  /* Section poses                                                       */
  /* ------------------------------------------------------------------ */
  // m = morph slot (0 front → 1 left → 2 right → 3 back → 4 front), ex = explode, ring = display ring
  const POSES = {
    desktop: [
      { x: 0, y: 0.22, s: 0.9, m: 0, ex: 0, ring: 0 },     // hero
      { x: 2.45, y: 0, s: 1, m: 1, ex: 0, ring: 0 },       // insulation
      { x: -2.55, y: 0, s: 1, m: 2, ex: 0, ring: 0 },      // shell
      { x: 2.25, y: 0, s: 0.98, m: 3, ex: 0, ring: 0 },    // ratings
      { x: 2.25, y: 0, s: 0.9, m: 3, ex: 1, ring: 0 },     // details (exploded)
      { x: 2.05, y: 0.32, s: 0.84, m: 4, ex: 0, ring: 1 }, // shop
    ],
    mobile: [
      { x: 0, y: 1.05, s: 0.5, m: 0, ex: 0, ring: 0 },
      { x: 0, y: 1.05, s: 0.5, m: 1, ex: 0, ring: 0 },
      { x: 0, y: 1.05, s: 0.5, m: 2, ex: 0, ring: 0 },
      { x: 0, y: 1.05, s: 0.5, m: 3, ex: 0, ring: 0 },
      { x: 0, y: 1.05, s: 0.5, m: 3, ex: 1, ring: 0 },
      { x: 0, y: 1.5, s: 0.44, m: 4, ex: 0, ring: 1 },
    ],
  };
  const KEYS = ["x", "y", "s", "m", "ex", "ring"];
  const sections = gsap.utils.toArray(".panel");
  const cur = { ...POSES.desktop[0] };
  const target = { ...cur };
  const intro = { ex: 1 };
  const pulse = { v: 0 };

  /* ------------------------------------------------------------------ */
  /* Smooth scroll                                                       */
  /* ------------------------------------------------------------------ */
  let lenis = null;
  if (!reduceMotion && typeof Lenis !== "undefined") {
    lenis = new Lenis({ lerp: 0.085, smoothWheel: true });
    lenis.on("scroll", ScrollTrigger.update);
    gsap.ticker.add((time) => lenis.raf(time * 1000));
    gsap.ticker.lagSmoothing(0);
    lenis.stop();
  }
  document.querySelectorAll('a[href^="#"]').forEach((a) => {
    a.addEventListener("click", (e) => {
      const id = a.getAttribute("href");
      const el = id.length > 1 && document.querySelector(id);
      if (!el) return;
      e.preventDefault();
      lenis ? lenis.scrollTo(el, { duration: 1.8 }) : el.scrollIntoView({ behavior: "smooth" });
    });
  });

  /* ------------------------------------------------------------------ */
  /* Scroll triggers                                                     */
  /* ------------------------------------------------------------------ */
  // Pinned horizontal details gallery (desktop). refreshPriority makes it
  // measure first so later triggers account for its pin spacer.
  const mm = gsap.matchMedia();
  mm.add("(min-width: 821px)", () => {
    const track = document.querySelector(".details-track");
    const dist = () => Math.max(0, track.scrollWidth - window.innerWidth);
    gsap.to(track, {
      x: () => -dist(),
      ease: "none",
      scrollTrigger: {
        trigger: "#details",
        start: "top top",
        end: () => "+=" + dist(),
        pin: true,
        scrub: 1,
        refreshPriority: 1,
        invalidateOnRefresh: true,
      },
    });
  });

  // Segment i runs while section i+1 scrolls up into view
  const segments = sections.slice(1).map((sec) =>
    ScrollTrigger.create({ trigger: sec, start: "top bottom", end: "top top" })
  );

  function computeTarget() {
    const poses = POSES[isMobile() ? "mobile" : "desktop"];
    Object.assign(target, poses[0]);
    segments.forEach((st, i) => {
      const p = st.progress;
      if (p <= 0) return;
      const e = easeInOut(p);
      KEYS.forEach((k) => (target[k] = lerp(poses[i][k], poses[i + 1][k], e)));
    });
  }

  /* ---------- Text reveals ---------- */
  document.querySelectorAll(".line").forEach((line) => (line.innerHTML = `<span>${line.innerHTML}</span>`));
  const heroLines = document.querySelectorAll(".panel--hero .line > span");
  gsap.set(heroLines, { yPercent: 115 });
  gsap.set(".reveal-hero", { y: 24, opacity: 0 });

  document.querySelectorAll(".panel:not(.panel--hero) .display").forEach((h) => {
    gsap.from(h.querySelectorAll(".line > span"), {
      yPercent: 115, rotate: 3, duration: 1.2, stagger: 0.08, ease: "expo.out",
      scrollTrigger: { trigger: h, start: "top 82%", toggleActions: "play none none reverse" },
    });
  });
  document.querySelectorAll(".panel:not(.panel--hero) .reveal").forEach((el) => {
    gsap.from(el, {
      y: 30, opacity: 0, filter: "blur(8px)", duration: 1.1, ease: "power3.out",
      scrollTrigger: { trigger: el, start: "top 88%", toggleActions: "play none none reverse" },
    });
  });
  gsap.from(".detail-card", {
    y: 60, opacity: 0, duration: 1.1, stagger: 0.08, ease: "power3.out",
    scrollTrigger: { trigger: "#details", start: "top 70%" },
  });

  document.querySelectorAll("[data-count]").forEach((el) => {
    const end = +el.dataset.count, pre = el.dataset.prefix || "", suf = el.dataset.suffix || "";
    const obj = { v: 0 };
    el.textContent = pre + 0 + suf;
    gsap.to(obj, {
      v: end, duration: 1.6, ease: "power3.out",
      onUpdate: () => (el.textContent = pre + Math.round(obj.v) + suf),
      scrollTrigger: { trigger: el, start: "top 90%" },
    });
  });

  /* ---------- Progress + nav state ---------- */
  const progNum = document.querySelector(".progress-num b");
  const progLabel = document.querySelector(".progress-label");
  const navLinks = document.querySelectorAll("[data-nav]");
  sections.forEach((sec, i) => {
    ScrollTrigger.create({
      trigger: sec, start: "top center", end: "bottom center",
      onToggle: (self) => {
        if (!self.isActive) return;
        progNum.textContent = String(i + 1).padStart(2, "0");
        progLabel.textContent = sec.dataset.name;
        navLinks.forEach((a) => a.classList.toggle("is-active", a.dataset.nav === sec.id));
      },
    });
  });
  gsap.to(".progress-fill", {
    scaleY: 1, ease: "none",
    scrollTrigger: { trigger: "#story", start: "top top", end: "bottom bottom", scrub: true },
  });

  /* ---------- Background ---------- */
  gsap.set(".beam:not(.beam--soft)", { xPercent: -50, yPercent: -50, rotate: -32 });
  gsap.to(".beam:not(.beam--soft)", {
    rotate: -10, xPercent: -90, ease: "none",
    scrollTrigger: { trigger: "#story", start: "top top", end: "bottom bottom", scrub: true },
  });
  gsap.set(".bg-word", { xPercent: -50, yPercent: -50 });
  gsap.to(".bg-word", {
    yPercent: -90, opacity: 0, ease: "none",
    scrollTrigger: { trigger: "#intro", start: "top top", end: "bottom top", scrub: true },
  });

  /* ------------------------------------------------------------------ */
  /* Shop + bag                                                          */
  /* ------------------------------------------------------------------ */
  const PRICE = 389;
  const colorName = document.getElementById("colorName");
  const sizeName = document.getElementById("sizeName");
  const selectIn = (group, btn) =>
    group.querySelectorAll("button").forEach((b) => {
      b.classList.toggle("is-active", b === btn);
      b.setAttribute("aria-checked", b === btn);
    });

  document.querySelectorAll(".swatch").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.classList.contains("is-active")) return;
      selectIn(btn.parentElement, btn);
      colorName.textContent = btn.dataset.name;
      const c = new THREE.Color(btn.dataset.tint);
      // burst into particles, recolour at the peak, reform
      gsap.timeline()
        .to(pulse, { v: 1, duration: 0.45, ease: "power2.in" })
        .to(shared.uTint.value, { r: c.r, g: c.g, b: c.b, duration: 0.3 }, 0.3)
        .to(pulse, { v: 0, duration: 0.9, ease: "power3.out" });
    });
  });
  document.querySelectorAll(".sizes button").forEach((btn) =>
    btn.addEventListener("click", () => {
      selectIn(btn.parentElement, btn);
      sizeName.textContent = btn.textContent;
    })
  );

  const bag = [];
  const bagCount = document.querySelector(".bag-count");
  const drawer = document.querySelector(".drawer");
  const scrim = document.querySelector(".drawer-scrim");
  const itemsEl = document.querySelector(".drawer-items");
  const emptyEl = document.querySelector(".drawer-empty");
  const totalEl = document.querySelector(".drawer-total b");
  const toast = document.querySelector(".toast");
  let toastTimer;
  const showToast = (msg) => {
    toast.textContent = msg;
    toast.classList.add("is-on");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("is-on"), 2200);
  };

  function renderBag() {
    const qty = bag.reduce((n, it) => n + it.qty, 0);
    bagCount.textContent = qty;
    totalEl.textContent = "$" + (qty * PRICE).toLocaleString();
    emptyEl.style.display = bag.length ? "none" : "";
    itemsEl.innerHTML = bag.map((it, i) => `
      <li class="drawer-item">
        <div class="drawer-thumb" style="background-image:url(assets/jacket-front.png)"></div>
        <div>
          <h4>Polar Down Jacket</h4>
          <small>${it.color} · ${it.size}</small>
          <div class="qty">
            <button type="button" data-dec="${i}" aria-label="Decrease quantity">−</button>
            <span>${it.qty}</span>
            <button type="button" data-inc="${i}" aria-label="Increase quantity">+</button>
          </div>
        </div>
        <div class="item-price">$${it.qty * PRICE}<button class="remove" type="button" data-rm="${i}">Remove</button></div>
      </li>`).join("");
  }
  itemsEl.addEventListener("click", (e) => {
    const t = e.target.closest("button");
    if (!t) return;
    if (t.dataset.inc) bag[+t.dataset.inc].qty++;
    if (t.dataset.dec && --bag[+t.dataset.dec].qty === 0) bag.splice(+t.dataset.dec, 1);
    if (t.dataset.rm) bag.splice(+t.dataset.rm, 1);
    renderBag();
  });

  const openDrawer = (open) => {
    drawer.classList.toggle("is-open", open);
    drawer.setAttribute("aria-hidden", !open);
    if (open) {
      scrim.hidden = false;
      requestAnimationFrame(() => scrim.classList.add("is-on"));
      lenis && lenis.stop();
    } else {
      scrim.classList.remove("is-on");
      setTimeout(() => (scrim.hidden = true), 400);
      lenis && lenis.start();
    }
  };
  document.querySelector(".bag").addEventListener("click", () => openDrawer(true));
  document.querySelector(".drawer-close").addEventListener("click", () => openDrawer(false));
  scrim.addEventListener("click", () => openDrawer(false));
  window.addEventListener("keydown", (e) => e.key === "Escape" && drawer.classList.contains("is-open") && openDrawer(false));
  document.querySelector(".checkout").addEventListener("click", () =>
    showToast(bag.length ? "This is a demo store — checkout coming soon" : "Your bag is empty")
  );

  document.querySelector(".add-to-bag").addEventListener("click", () => {
    const color = colorName.textContent, size = sizeName.textContent;
    const found = bag.find((it) => it.color === color && it.size === size);
    found ? found.qty++ : bag.push({ color, size, qty: 1 });
    renderBag();
    gsap.fromTo(bagCount, { scale: 1.7 }, { scale: 1, duration: 0.6, ease: "back.out(3)" });
    showToast(`Added · ${color} · ${size}`);
  });
  renderBag();

  document.querySelector(".newsletter").addEventListener("submit", (e) => {
    e.preventDefault();
    e.target.querySelector("button").textContent = "Joined ✓";
  });

  /* ------------------------------------------------------------------ */
  /* Pointer + cursor                                                    */
  /* ------------------------------------------------------------------ */
  const mouse = { x: 0, y: 0, tx: 0, ty: 0, px: -999, py: -999, inside: false };
  window.addEventListener("pointermove", (e) => {
    mouse.tx = (e.clientX / window.innerWidth) * 2 - 1;
    mouse.ty = (e.clientY / window.innerHeight) * 2 - 1;
    mouse.px = e.clientX;
    mouse.py = e.clientY;
    mouse.inside = true;
  });
  document.addEventListener("pointerleave", () => (mouse.inside = false));

  const cursor = document.querySelector(".cursor");
  const cDot = cursor.querySelector(".cursor-dot");
  const cRing = cursor.querySelector(".cursor-ring");
  const cLabel = cRing.querySelector("em");
  const ringPos = { x: -100, y: -100 };
  let overUI = false;
  let overJacket = false;
  if (finePointer) {
    document.documentElement.classList.add("has-cursor");
    document.addEventListener("pointerover", (e) => {
      const card = e.target.closest(".detail-card");
      const link = e.target.closest("a, button, input");
      overUI = !!(card || link);
      cursor.classList.toggle("is-label", !!card);
      cLabel.textContent = card ? "View" : "";
      cursor.classList.toggle("is-link", (!!link && !card) || (!overUI && overJacket));
    });
  }

  const ray = new THREE.Raycaster();
  const plane = new THREE.Plane();
  const hit = new V();
  const ndc = new THREE.Vector2();
  const ZN = new V(0, 0, 1);

  /* ------------------------------------------------------------------ */
  /* Resize                                                              */
  /* ------------------------------------------------------------------ */
  function resize() {
    const w = window.innerWidth, h = window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  resize();
  let resizeTimer;
  window.addEventListener("resize", () => {
    resize();
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => ScrollTrigger.refresh(), 200);
  });

  /* ------------------------------------------------------------------ */
  /* Frame loop                                                          */
  /* ------------------------------------------------------------------ */
  const clock = new THREE.Clock();
  const motion = reduceMotion ? 0 : 1;

  function tick() {
    if (!particles) return;
    const dt = Math.min(clock.getDelta(), 0.05);
    const t = clock.elapsedTime;
    shared.uTime.value = t;

    computeTarget();
    const follow = 1 - Math.exp(-dt * 6);
    KEYS.forEach((k) => (cur[k] += (target[k] - cur[k]) * follow));

    mouse.x += (mouse.tx - mouse.x) * 0.06;
    mouse.y += (mouse.ty - mouse.y) * 0.06;

    // pose
    jacket.position.set(cur.x, cur.y + Math.sin(t * 0.8) * 0.04 * motion, 0);
    jacket.rotation.set(mouse.y * 0.05 * motion, mouse.x * 0.1 * motion, 0);
    jacket.scale.setScalar(cur.s);

    // morph state
    const m = clamp01(cur.m / 4) * 4;
    const seg = Math.min(3, Math.floor(m));
    setSegment(seg);
    const f = smoothstep(0.12, 0.88, m - seg);
    const ex = Math.max(cur.ex, intro.ex);
    const solid = 1 - smoothstep(0, 0.55, ex);

    pUniforms.uF.value = f;
    pUniforms.uEx.value = ex;
    pUniforms.uPulse.value = pulse.v;
    pUniforms.uSize.value = (isMobile() ? 2.4 : 2.7) * DPR * Math.max(0.6, cur.s);

    planes.forEach((p, slot) => {
      let vis = 0;
      if (slot === seg) vis = 1 - smoothstep(0, 0.32, f);
      if (slot === seg + 1) vis = smoothstep(0.68, 1, f);
      vis *= solid * (1 - pulse.v);
      p.material.uniforms.uVis.value = vis;
      p.visible = vis > 0.001;
    });

    // hover: cursor position in the jacket's local plane
    jacket.updateMatrixWorld();
    let hoverTarget = 0;
    if (finePointer && mouse.inside && !overUI && !drawer.classList.contains("is-open")) {
      ndc.set((mouse.px / window.innerWidth) * 2 - 1, -(mouse.py / window.innerHeight) * 2 + 1);
      ray.setFromCamera(ndc, camera);
      plane.set(ZN, 0).applyMatrix4(jacket.matrixWorld);
      if (ray.ray.intersectPlane(plane, hit)) {
        jacket.worldToLocal(hit);
        shared.uMouse.value.set(hit.x, hit.y);
        const W = views[SEQ[f < 0.5 ? seg : seg + 1]].W;
        const inside = Math.abs(hit.x) < W / 2 && Math.abs(hit.y) < JH / 2;
        const crisp = f < 0.02 || f > 0.98;
        hoverTarget = inside && crisp && ex < 0.05 ? 1 : 0;
      }
    }
    shared.uHover.value += (hoverTarget - shared.uHover.value) * 0.1;
    if (finePointer && !!hoverTarget !== overJacket) {
      overJacket = !!hoverTarget;
      if (!overUI) cursor.classList.toggle("is-link", overJacket);
    }

    // ring
    const rv = cur.ring;
    ring.visible = rv > 0.01;
    ring.userData.pool.material.opacity = rv;
    ring.userData.band.material.opacity = rv * 0.9;
    ring.userData.orbit.material.opacity = rv;
    ring.userData.orbit.rotation.y = t * 0.15;
    ring.scale.setScalar(0.8 + rv * 0.2);

    // plexus
    const sp = 0.016 * motion;
    for (let i = 0; i < PN; i++) {
      for (let a = 0; a < 3; a++) nodePos[i * 3 + a] += nodeVel[i * 3 + a] * sp;
      if (Math.abs(nodePos[i * 3]) > 11) nodeVel[i * 3] *= -1;
      if (Math.abs(nodePos[i * 3 + 1]) > 6.5) nodeVel[i * 3 + 1] *= -1;
      if (nodePos[i * 3 + 2] > -2 || nodePos[i * 3 + 2] < -8) nodeVel[i * 3 + 2] *= -1;
    }
    // cursor projected to the plexus depth so nearby nodes reach for it
    let mx = 999, my = 999;
    if (mouse.inside) {
      ndc.set((mouse.px / window.innerWidth) * 2 - 1, -(mouse.py / window.innerHeight) * 2 + 1);
      ray.setFromCamera(ndc, camera);
      plane.set(ZN, 5);
      if (ray.ray.intersectPlane(plane, hit)) { mx = hit.x; my = hit.y; }
    }
    const py = (window.scrollY / window.innerHeight) * 0.35;
    plexus.position.y = py;
    my -= py;
    let L = 0;
    const plexusFade = 0.55 + ex * 0.45;
    for (let i = 0; i < PN && L < MAXL; i++) {
      const ix = nodePos[i * 3], iy = nodePos[i * 3 + 1], iz = nodePos[i * 3 + 2];
      for (let j = i + 1; j < PN && L < MAXL; j++) {
        const dx = ix - nodePos[j * 3], dy = iy - nodePos[j * 3 + 1], dz = iz - nodePos[j * 3 + 2];
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (d > LINK) continue;
        const a = (1 - d / LINK) * 0.42 * plexusFade;
        linePos.set([ix, iy, iz, nodePos[j * 3], nodePos[j * 3 + 1], nodePos[j * 3 + 2]], L * 6);
        lineCol.set([0.62 * a, 0.7 * a, a, 0.62 * a, 0.7 * a, a], L * 6);
        L++;
      }
      const mdx = ix - mx, mdy = iy - my;
      const md = Math.sqrt(mdx * mdx + mdy * mdy);
      if (md < 3.4 && L < MAXL) {
        const a = (1 - md / 3.4) * 0.8;
        linePos.set([ix, iy, iz, mx, my, -5], L * 6);
        lineCol.set([0.7 * a, 0.78 * a, a, 0, 0, 0], L * 6);
        L++;
      }
    }
    lineGeo.setDrawRange(0, L * 2);
    lineGeo.attributes.position.needsUpdate = true;
    lineGeo.attributes.color.needsUpdate = true;
    nodeGeo.attributes.position.needsUpdate = true;

    // dust: falls faster while scrolling
    const vel = lenis ? Math.min(Math.abs(lenis.velocity), 60) : 0;
    const fall = (1 + vel * 0.08) * motion;
    for (let i = 0; i < DUST; i++) {
      const iy = i * 3 + 1;
      dustPos[iy] -= dustSpd[i] * dt * fall;
      if (dustPos[iy] < -6.5) dustPos[iy] = 6.5;
    }
    dustGeo.attributes.position.needsUpdate = true;

    camera.position.set(mouse.x * 0.25 * motion, -mouse.y * 0.15 * motion, 10);
    camera.lookAt(0, 0, 0);

    if (finePointer) {
      cDot.style.transform = `translate(${mouse.px}px, ${mouse.py}px)`;
      ringPos.x += (mouse.px - ringPos.x) * 0.18;
      ringPos.y += (mouse.py - ringPos.y) * 0.18;
      cRing.style.transform = `translate(${ringPos.x}px, ${ringPos.y}px)`;
    }

    renderer.render(scene, camera);
  }
  gsap.ticker.add(tick);

  /* ------------------------------------------------------------------ */
  /* Boot                                                                */
  /* ------------------------------------------------------------------ */
  Promise.all(VIEW_NAMES.map((n) => loadImage(`assets/jacket-${n}.png`))).then((images) => {
    buildJacket(images);
    const fontsReady = document.fonts ? document.fonts.ready : Promise.resolve();
    Promise.race([fontsReady, new Promise((r) => setTimeout(r, 1500))]).then(() => {
      ScrollTrigger.refresh();
      computeTarget();
      Object.assign(cur, target);
      gsap.timeline({ delay: 0.25 })
        .to(loader, { opacity: 0, duration: 0.7, ease: "power2.out", onComplete: () => { loader.remove(); lenis && lenis.start(); } })
        .to(intro, { ex: 0, duration: 2.6, ease: "power3.inOut" }, 0.1)
        .to(heroLines, { yPercent: 0, duration: 1.3, stagger: 0.1, ease: "expo.out" }, 1.1)
        .to(".reveal-hero", { y: 0, opacity: 1, duration: 1, stagger: 0.08, ease: "power3.out" }, 1.3)
        .from(".nav, .progress", { y: -16, opacity: 0, duration: 1, ease: "power3.out" }, 1.2);
    });
  });
})();
