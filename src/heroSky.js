const COVERAGE = [[5, 0], [10, .06], [20, .17], [30, .29], [50, .50], [70, .72], [85, .89], [100, 1]]
const clamp = (value) => Math.max(0, Math.min(1, value))

function smooth(value) {
  const t = clamp(value)
  return t * t * (3 - 2 * t)
}

export function cloudAppearance(cloud) {
  if (!Number.isFinite(cloud)) return { kind: 'unavailable' }
  if (cloud <= 5) return { kind: 'clear' }
  const percent = Math.min(cloud, 100)
  const upper = COVERAGE.findIndex(([end]) => percent <= end)
  const [start, from] = COVERAGE[upper - 1]
  const [end, to] = COVERAGE[upper]
  return {
    kind: 'cloudy',
    area: from + (to - from) * (percent - start) / (end - start),
    opacity: .72 * smooth((percent - 5) / 7) + .28 * smooth((percent - 55) / 45),
    overcast: smooth((percent - 85) / 15),
  }
}

function noiseGrid(columns, rows, random) {
  const values = Array.from({ length: (columns + 1) * (rows + 1) }, random)
  return (x, y) => {
    const xx = Math.min(columns - 1e-6, x * columns)
    const yy = Math.min(rows - 1e-6, y * rows)
    const col = Math.floor(xx), row = Math.floor(yy)
    const u = smooth(xx - col), v = smooth(yy - row)
    const i = row * (columns + 1) + col
    const top = values[i] * (1 - u) + values[i + 1] * u
    const bottom = values[i + columns + 1] * (1 - u) + values[i + columns + 2] * u
    return top * (1 - v) + bottom * v
  }
}

function makeTexture(width, height) {
  let seed = 910276
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return seed / 4294967296
  }
  const broad = noiseGrid(6, 5, random)
  const medium = noiseGrid(16, 10, random)
  const fine = noiseGrid(43, 30, random)
  const field = new Float32Array(width * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const u = x / width, v = y / height
      const detail = medium(u, v)
      field[y * width + x] = .57 * broad(u, clamp(v * .91 + .07 * detail)) + .29 * detail + .14 * fine(u, v)
    }
  }
  // Rank densities over the part of the photo that survives the hero crops.
  const visibleSky = field.subarray(Math.floor(.46 * height) * width, Math.floor(.84 * height) * width)
  return { field, ranks: visibleSky.slice().sort() }
}

const layers = new WeakMap()

export function paintHeroClouds(canvas, cloud) {
  let layer = layers.get(canvas)
  if (!layer) {
    const ctx = canvas.getContext('2d')
    if (!ctx) return false
    layer = { ctx }
    layers.set(canvas, layer)
  }
  if (Object.is(layer.cloud, cloud)) return true
  layer.cloud = cloud
  const { ctx } = layer
  const { width, height } = canvas
  const appearance = cloudAppearance(cloud)
  if (appearance.kind !== 'cloudy') {
    ctx.clearRect(0, 0, width, height)
    return true
  }

  layer.texture ??= makeTexture(width, height)
  layer.pixels ??= ctx.createImageData(width, height)
  const { field, ranks } = layer.texture
  const { area, opacity, overcast } = appearance
  const threshold = ranks[Math.floor((1 - area) * (ranks.length - 1))]
  for (let i = 0; i < field.length; i++) {
    const body = smooth((field[i] - threshold) / .075)
    const colour = 36 + 35 * field[i] + 14 * Math.floor(i / width) / height
    layer.pixels.data[i * 4] = colour
    layer.pixels.data[i * 4 + 1] = colour + 3
    layer.pixels.data[i * 4 + 2] = colour + 17
    layer.pixels.data[i * 4 + 3] = 255 * opacity * (body + (1 - body) * overcast)
  }
  ctx.putImageData(layer.pixels, 0, 0)
  return true
}
