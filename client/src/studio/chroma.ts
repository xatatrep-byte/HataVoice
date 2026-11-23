/**
 * A green screen, on the video card: one color of a frame turns transparent. Canvas 2D cannot do it at a frame's speed,
 * so a small shader does, and its canvas is drawn into the frame like any picture.
 */

const VERTEX = `#version 300 es
in vec2 corner;
out vec2 uv;
void main() {
  uv = vec2(corner.x * 0.5 + 0.5, 0.5 - corner.y * 0.5);
  gl_Position = vec4(corner, 0.0, 1.0);
}`;

const FRAGMENT = `#version 300 es
precision mediump float;
in vec2 uv;
out vec4 color;
uniform sampler2D picture;
uniform vec3 key;
uniform float similarity;
uniform float smoothness;
// Compares by chroma alone: a shadow on the green is still green.
vec2 chroma(vec3 c) {
  return vec2(dot(c, vec3(-0.169, -0.331, 0.5)), dot(c, vec3(0.5, -0.419, -0.081)));
}
void main() {
  vec4 p = texture(picture, uv);
  float distance = length(chroma(p.rgb) - chroma(key));
  float alpha = smoothstep(similarity, similarity + smoothness, distance);
  // What is left near the edge loses the color spill of the screen behind it.
  float luma = dot(p.rgb, vec3(0.299, 0.587, 0.114));
  vec3 cleaned = mix(vec3(luma), p.rgb, smoothstep(similarity, similarity + smoothness * 2.0, distance));
  color = vec4(cleaned * alpha, alpha);
}`;

type Keyer = {
  canvas: OffscreenCanvas;
  gl: WebGL2RenderingContext;
  key: WebGLUniformLocation | null;
  similarity: WebGLUniformLocation | null;
  smoothness: WebGLUniformLocation | null;
};

let keyer: Keyer | null = null;

function setUp(): Keyer {
  const canvas = new OffscreenCanvas(16, 16);
  const gl = canvas.getContext("webgl2", { premultipliedAlpha: true, alpha: true });
  if (!gl) throw new Error("WebGL2 недоступен");
  const compile = (type: number, source: string) => {
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    return shader;
  };
  const program = gl.createProgram()!;
  gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX));
  gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAGMENT));
  gl.linkProgram(program);
  gl.useProgram(program);
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const corner = gl.getAttribLocation(program, "corner");
  gl.enableVertexAttribArray(corner);
  gl.vertexAttribPointer(corner, 2, gl.FLOAT, false, 0, 0);
  gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return {
    canvas,
    gl,
    key: gl.getUniformLocation(program, "key"),
    similarity: gl.getUniformLocation(program, "similarity"),
    smoothness: gl.getUniformLocation(program, "smoothness"),
  };
}

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.replace("#", ""), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** `frame` with one color gone, as a canvas of the frame's own size. */
export function chromaKey(frame: VideoFrame, settings: { color: string; similarity: number; smooth: number }): OffscreenCanvas {
  keyer ??= setUp();
  const { canvas, gl } = keyer;
  if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
    canvas.width = frame.displayWidth;
    canvas.height = frame.displayHeight;
    gl.viewport(0, 0, canvas.width, canvas.height);
  }
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame);
  gl.uniform3fv(keyer.key, rgb(settings.color));
  gl.uniform1f(keyer.similarity, settings.similarity);
  gl.uniform1f(keyer.smoothness, Math.max(0.001, settings.smooth));
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  return canvas;
}
