import sharp from 'sharp'
import pngToIco from 'png-to-ico'
import { mkdir, writeFile, readFile } from 'fs/promises'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')
const logoPath = join(root, 'src/assets/logo.svg')
const iconsDir = join(root, 'public/icons')
const screenshotsDir = join(root, 'public/screenshots')

const sizes = [72, 96, 128, 144, 152, 192, 384, 512]

async function main() {
  await mkdir(iconsDir, { recursive: true })
  await mkdir(screenshotsDir, { recursive: true })

  const logo = await readFile(logoPath)

  for (const size of sizes) {
    await sharp(logo, { density: 384 })
      .resize(size, size)
      .png()
      .toFile(join(iconsDir, `icon-${size}.png`))
  }
  console.log(`Generated ${sizes.length} icon sizes`)

  // favicon.ico from 16/32/48 renders
  const icoSizes = [16, 32, 48]
  const icoBuffers = await Promise.all(
    icoSizes.map((size) => sharp(logo, { density: 384 }).resize(size, size).png().toBuffer())
  )
  const ico = await pngToIco(icoBuffers)
  await writeFile(join(root, 'public/favicon.ico'), ico)
  console.log('Generated favicon.ico')

  // Placeholder install screenshots (narrow = mobile portrait, wide = desktop)
  await renderScreenshot(390, 844, join(screenshotsDir, 'narrow.png'))
  await renderScreenshot(1280, 720, join(screenshotsDir, 'wide.png'))
  console.log('Generated placeholder screenshots')
}

async function renderScreenshot(width, height, outPath) {
  const logoSize = Math.round(Math.min(width, height) * 0.35)
  const logoPng = await sharp(logoPath, { density: 384 }).resize(logoSize, logoSize).png().toBuffer()

  const svg = `
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <rect width="${width}" height="${height}" fill="#0a0e14"/>
    </svg>
  `

  await sharp(Buffer.from(svg))
    .composite([
      {
        input: logoPng,
        left: Math.round((width - logoSize) / 2),
        top: Math.round((height - logoSize) / 2 - height * 0.05),
      },
    ])
    .png()
    .toFile(outPath)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
