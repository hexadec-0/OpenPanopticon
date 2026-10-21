/**
 * optics.js — sensor emulation via Cesium PostProcessStage.
 *
 * Each mode is a full-screen fragment shader run after the scene renders.
 * Cesium's GLSL conventions: `in vec2 v_textureCoordinates`, sample with
 * texture(colorTexture, ...), write to `out_FragColor`.
 */

const COMMON = `
  uniform sampler2D colorTexture;
  uniform sampler2D depthTexture;
  uniform vec2  resolution;
  uniform float uTime;
  in vec2 v_textureCoordinates;

  float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
  }

  // amount = how dark the corners get (0..1); start = radius where falloff begins.
  // Note both smoothstep edges must be ordered low..high or the result is undefined.
  float vignette(vec2 uv, float amount, float start) {
    float r = length(uv - 0.5) * 1.41421356;   // 0 centre, ~1 corner
    return 1.0 - smoothstep(start, 1.0, r) * amount;
  }
`;

/* ------------------------------------------------------------------ */
/* FLIR — thermal. Ironbow ramp over an inverted-ish luminance proxy,  */
/* plus a hot-spot detector that pushes peaks to white.                */
/* ------------------------------------------------------------------ */
const FLIR = `${COMMON}
  vec3 ironbow(float t) {
    t = clamp(t, 0.0, 1.0);
    vec3 c = mix(vec3(0.02, 0.00, 0.14), vec3(0.42, 0.02, 0.44), smoothstep(0.00, 0.32, t));
    c  = mix(c, vec3(0.86, 0.16, 0.20), smoothstep(0.32, 0.56, t));
    c  = mix(c, vec3(0.99, 0.62, 0.05), smoothstep(0.56, 0.76, t));
    c  = mix(c, vec3(1.00, 0.94, 0.55), smoothstep(0.76, 0.90, t));
    c  = mix(c, vec3(1.00, 1.00, 1.00), smoothstep(0.90, 1.00, t));
    return c;
  }

  void main() {
    vec2 uv = v_textureCoordinates;
    vec2 px = 1.0 / resolution;
    vec3 src = texture(colorTexture, uv).rgb;

    // Radiometric proxy: warm channels read hotter than cool ones.
    float heat = dot(src, vec3(0.52, 0.38, 0.10));

    // Local contrast stretch (crude AGC) so flat scenes still separate.
    float around = 0.0;
    for (int i = -3; i <= 3; i++) {
      around += dot(texture(colorTexture, uv + vec2(float(i), 0.0) * px * 4.0).rgb,
                    vec3(0.52, 0.38, 0.10));
    }
    around /= 7.0;
    heat = clamp(0.26 + (heat - around) * 2.4 + heat * 0.88, 0.0, 1.0);

    // Sensor noise + faint horizontal FPN banding.
    heat += (hash(uv * resolution + fract(uTime) * 97.0) - 0.5) * 0.045;
    heat += sin(uv.y * resolution.y * 0.5) * 0.008;

    vec3 col = ironbow(heat);
    col *= vignette(uv, 0.55, 0.32);
    out_FragColor = vec4(col, 1.0);
  }
`;

/* ------------------------------------------------------------------ */
/* CRT — shadow mask, scanlines, chromatic misconvergence, bloom.      */
/* ------------------------------------------------------------------ */
const CRT = `${COMMON}
  void main() {
    vec2 uv = v_textureCoordinates;

    // Barrel distortion of the glass.
    vec2 c = uv - 0.5;
    float r2 = dot(c, c);
    uv = 0.5 + c * (1.0 + r2 * 0.085);

    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
      out_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
      return;
    }

    // Misconverged guns.
    vec2 px = 1.0 / resolution;
    float rr = texture(colorTexture, uv + vec2( 1.4, 0.0) * px).r;
    float gg = texture(colorTexture, uv).g;
    float bb = texture(colorTexture, uv - vec2( 1.4, 0.0) * px).b;
    vec3 col = vec3(rr, gg, bb);

    // Aperture grille.
    float grille = 0.86 + 0.14 * sin(uv.x * resolution.x * 3.14159);
    float scan   = 0.78 + 0.22 * sin(uv.y * resolution.y * 3.14159);
    col *= grille * scan;

    // Rolling refresh bar.
    float roll = smoothstep(0.0, 0.08, fract(uv.y + uTime * 0.09));
    col *= 0.93 + 0.07 * roll;

    // Phosphor persistence glow + slight green cast.
    col += vec3(0.02, 0.05, 0.03) * luma(col);
    col *= 1.28;
    col *= vignette(uv, 0.70, 0.26);

    // Interference speckle.
    col += (hash(uv * resolution + fract(uTime) * 611.0) - 0.5) * 0.035;

    out_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
  }
`;

/* ------------------------------------------------------------------ */
/* SAR — synthetic-aperture-radar look: monochrome, speckle,           */
/* edge-driven backscatter, range lines.                               */
/* ------------------------------------------------------------------ */
const SAR = `${COMMON}
  void main() {
    vec2 uv = v_textureCoordinates;
    vec2 px = 1.0 / resolution;

    // Sobel: vertical structure returns strong backscatter.
    float tl = luma(texture(colorTexture, uv + vec2(-1.0,  1.0) * px).rgb);
    float t  = luma(texture(colorTexture, uv + vec2( 0.0,  1.0) * px).rgb);
    float tr = luma(texture(colorTexture, uv + vec2( 1.0,  1.0) * px).rgb);
    float l  = luma(texture(colorTexture, uv + vec2(-1.0,  0.0) * px).rgb);
    float rc = luma(texture(colorTexture, uv + vec2( 1.0,  0.0) * px).rgb);
    float bl = luma(texture(colorTexture, uv + vec2(-1.0, -1.0) * px).rgb);
    float b  = luma(texture(colorTexture, uv + vec2( 0.0, -1.0) * px).rgb);
    float br = luma(texture(colorTexture, uv + vec2( 1.0, -1.0) * px).rgb);

    float gx = (tr + 2.0 * rc + br) - (tl + 2.0 * l + bl);
    float gy = (tl + 2.0 * t + tr) - (bl + 2.0 * b + br);
    float edge = length(vec2(gx, gy));

    float base = luma(texture(colorTexture, uv).rgb);
    float sigma = clamp(base * 0.42 + edge * 1.25, 0.0, 1.0);

    // Multiplicative speckle — the signature of coherent imaging.
    float speck = hash(uv * resolution * 1.7 + fract(uTime) * 13.0);
    sigma *= 0.62 + speck * 0.76;

    // Range lines.
    sigma *= 0.97 + 0.03 * sin(uv.y * resolution.y * 0.9);

    vec3 col = vec3(pow(clamp(sigma, 0.0, 1.0), 0.85));
    col *= vec3(0.92, 0.97, 1.0);   // faint cold cast
    col *= vignette(uv, 0.45, 0.38);
    out_FragColor = vec4(col, 1.0);
  }
`;

/* ------------------------------------------------------------------ */
/* CEL — posterised, ink-outlined. The "why does surveillance have to  */
/* look grim" mode.                                                    */
/* ------------------------------------------------------------------ */
const CEL = `${COMMON}
  void main() {
    vec2 uv = v_textureCoordinates;
    vec2 px = 1.0 / resolution;
    vec3 src = texture(colorTexture, uv).rgb;

    // Quantise to paint bands.
    vec3 posterised = floor(src * 6.0 + 0.5) / 6.0;

    // Lift saturation the way cel paint does.
    float l = luma(posterised);
    posterised = mix(vec3(l), posterised, 1.45);

    // Ink line from a luminance Sobel.
    float tl = luma(texture(colorTexture, uv + vec2(-1.0,  1.0) * px).rgb);
    float t  = luma(texture(colorTexture, uv + vec2( 0.0,  1.0) * px).rgb);
    float tr = luma(texture(colorTexture, uv + vec2( 1.0,  1.0) * px).rgb);
    float lf = luma(texture(colorTexture, uv + vec2(-1.0,  0.0) * px).rgb);
    float rt = luma(texture(colorTexture, uv + vec2( 1.0,  0.0) * px).rgb);
    float bl = luma(texture(colorTexture, uv + vec2(-1.0, -1.0) * px).rgb);
    float bt = luma(texture(colorTexture, uv + vec2( 0.0, -1.0) * px).rgb);
    float br = luma(texture(colorTexture, uv + vec2( 1.0, -1.0) * px).rgb);
    float gx = (tr + 2.0 * rt + br) - (tl + 2.0 * lf + bl);
    float gy = (tl + 2.0 * t  + tr) - (bl + 2.0 * bt + br);
    float ink = 1.0 - smoothstep(0.12, 0.42, length(vec2(gx, gy)));

    vec3 col = posterised * ink;
    col = mix(col, col * vec3(1.03, 1.01, 0.94), 0.6);  // warm daylight grade
    out_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
  }
`;

export const OPTICAL_MODES = {
  eo:   { label: 'EO',   caption: 'Electro-optical — unfiltered',      shader: null, hud: '#39ff88' },
  flir: { label: 'FLIR', caption: 'Thermal infrared — ironbow',        shader: FLIR, hud: '#ffb45c' },
  sar:  { label: 'SAR',  caption: 'Synthetic aperture radar — X-band', shader: SAR,  hud: '#9fd8ff' },
  crt:  { label: 'CRT',  caption: 'Analogue downlink — 1987',          shader: CRT,  hud: '#8cff6b' },
  cel:  { label: 'CEL',  caption: 'Non-photorealistic — cel shaded',   shader: CEL,  hud: '#ffd4a3' },
};

export class OpticsController {
  constructor(viewer) {
    this.viewer = viewer;
    this.stage = null;
    this.mode = 'eo';
    this.start = performance.now();
  }

  set(mode) {
    const spec = OPTICAL_MODES[mode];
    if (!spec) return;
    this.mode = mode;

    if (this.stage) {
      this.viewer.scene.postProcessStages.remove(this.stage);
      this.stage = null;
    }
    if (!spec.shader) return;

    const scene = this.viewer.scene;
    this.stage = scene.postProcessStages.add(
      new Cesium.PostProcessStage({
        name: `openpanopticon_${mode}`,
        fragmentShader: spec.shader,
        uniforms: {
          resolution: () => {
            const { drawingBufferWidth: w, drawingBufferHeight: h } = scene.context;
            return new Cesium.Cartesian2(w || 1920, h || 1080);
          },
          uTime: () => (performance.now() - this.start) / 1000,
        },
      }),
    );
  }
}
