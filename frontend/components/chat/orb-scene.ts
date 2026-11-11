import {
  Mesh, OrthographicCamera, Scene, ShaderMaterial, SphereGeometry, Vector2, WebGLRenderer,
} from "three";

const vertexShader = /* glsl */ `
  uniform vec2 uPointer;
  uniform float uHover;
  varying vec3 vNormal;
  varying vec3 vSurface;

  void main() {
    float ripple = sin(5.0 * position.y + 2.4 * position.x + uPointer.x)
      * cos(4.0 * position.z - uPointer.y);
    vec3 deformed = position * (1.0 + (0.025 + 0.035 * uHover) * ripple);
    vSurface = position;
    vNormal = normalize(normalMatrix * normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(deformed, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  uniform vec2 uPointer;
  uniform float uHover;
  varying vec3 vNormal;
  varying vec3 vSurface;

  void main() {
    vec3 n = normalize(vNormal);
    vec3 pale = vec3(0.96, 0.93, 1.0);
    vec3 violet = vec3(0.62, 0.46, 0.87);
    vec3 blue = vec3(0.77, 0.71, 0.98);
    float rim = pow(1.0 - max(n.z, 0.0), 2.15);
    float shadow = smoothstep(-0.25, 0.95, dot(n, normalize(vec3(-0.9, -0.64, 0.18))));
    vec3 color = mix(pale, mix(blue, violet, shadow), rim * 0.89 + shadow * 0.19);

    float fold = vSurface.y + 0.26 * sin(vSurface.x * 3.1 + vSurface.z * 2.0) + uPointer.y * 0.12;
    float ribbon = exp(-abs(fold - 0.02) * 8.5);
    color = mix(color, blue, ribbon * (0.16 + 0.10 * uHover));

    vec3 light = normalize(vec3(-0.30 + uPointer.x * 0.27, 0.65 + uPointer.y * 0.21, 0.61));
    float glaze = pow(max(dot(n, light), 0.0), 16.0);
    float edgeDistance = (n.z - 0.31) * 9.0;
    float edge = exp(-edgeDistance * edgeDistance);
    float reflection = smoothstep(0.08, 0.84, dot(n, normalize(vec3(0.60, 0.79, 0.05))));
    color = mix(color, vec3(1.0), min(0.87, glaze * 0.76 + edge * reflection * 0.85));

    float alpha = smoothstep(0.0, 0.24, n.z) * (0.70 + 0.24 * rim);
    gl_FragColor = vec4(color, alpha);
  }
`;

export function mountOrb(host: HTMLDivElement) {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("webgl2", { alpha: true, antialias: true, powerPreference: "low-power" });
  if (!context) return;

  const renderer = new WebGLRenderer({ canvas, context, alpha: true, antialias: true });
  const scene = new Scene();
  const camera = new OrthographicCamera(-1.33, 1.33, 1.33, -1.33, 0.1, 12);
  camera.position.z = 4;
  const geometry = new SphereGeometry(1, 64, 40);
  const position = new Vector2();
  const target = new Vector2();
  const uniforms = { uPointer: { value: position }, uHover: { value: 0 } };
  const material = new ShaderMaterial({ vertexShader, fragmentShader, uniforms, transparent: true });
  const orb = new Mesh(geometry, material);
  scene.add(orb);

  const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
  let hoverTarget = 0;
  let frame = 0;
  let previous = 0;
  let contextLost = false;

  function draw() {
    orb.position.set(position.x * 0.084, position.y * 0.084, 0);
    orb.rotation.set(-position.y * 0.23, position.x * 0.25, -0.18 + position.x * 0.10);
    renderer.render(scene, camera);
    host.dataset.rendered = "true";
  }

  function animate(now: number) {
    frame = 0;
    const ease = 1 - Math.exp(-Math.min(previous ? now - previous : 16, 32) / 105);
    previous = now;
    position.lerp(target, ease);
    uniforms.uHover.value += (hoverTarget - uniforms.uHover.value) * ease;
    if (position.distanceToSquared(target) > 0.000025 || Math.abs(hoverTarget - uniforms.uHover.value) > 0.005) {
      draw();
      frame = requestAnimationFrame(animate);
    } else {
      position.copy(target);
      uniforms.uHover.value = hoverTarget;
      draw();
      previous = 0;
    }
  }

  function schedule() {
    if (!frame && !document.hidden && !contextLost) frame = requestAnimationFrame(animate);
  }

  function move(event: PointerEvent) {
    if (motion.matches || event.pointerType === "touch") return;
    const bounds = host.getBoundingClientRect();
    target.set(2 * (event.clientX - bounds.left) / bounds.width - 1,
      1 - 2 * (event.clientY - bounds.top) / bounds.height);
    hoverTarget = 1;
    schedule();
  }

  function reset() {
    target.set(0, 0);
    hoverTarget = 0;
    if (motion.matches) {
      cancelAnimationFrame(frame);
      frame = previous = 0;
      position.set(0, 0);
      uniforms.uHover.value = 0;
      if (!contextLost && !document.hidden) draw();
    } else schedule();
  }

  function size() {
    if (contextLost) return;
    const side = Math.max(1, Math.round(host.clientWidth));
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    renderer.setSize(side, side, false);
    draw();
  }

  function lost() {
    contextLost = true;
    cancelAnimationFrame(frame);
    frame = previous = 0;
    delete host.dataset.rendered;
  }

  function restored() {
    contextLost = false;
    size();
  }

  function visibility() {
    if (document.hidden) {
      cancelAnimationFrame(frame);
      frame = previous = 0;
    } else if (motion.matches) reset();
    else schedule();
  }

  host.append(canvas);
  size();
  const resize = new ResizeObserver(size);
  resize.observe(host);
  host.addEventListener("pointermove", move);
  host.addEventListener("pointerleave", reset);
  host.addEventListener("pointercancel", reset);
  canvas.addEventListener("webglcontextlost", lost);
  canvas.addEventListener("webglcontextrestored", restored);
  document.addEventListener("visibilitychange", visibility);
  motion.addEventListener("change", reset);

  return () => {
    cancelAnimationFrame(frame);
    resize.disconnect();
    host.removeEventListener("pointermove", move);
    host.removeEventListener("pointerleave", reset);
    host.removeEventListener("pointercancel", reset);
    canvas.removeEventListener("webglcontextlost", lost);
    canvas.removeEventListener("webglcontextrestored", restored);
    document.removeEventListener("visibilitychange", visibility);
    motion.removeEventListener("change", reset);
    geometry.dispose();
    material.dispose();
    renderer.dispose();
    renderer.forceContextLoss();
    canvas.remove();
    delete host.dataset.rendered;
  };
}
