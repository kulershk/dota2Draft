import multer from 'multer'
import crypto from 'crypto'
import fs from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))
export const uploadsDir = join(__dirname, '..', '..', 'uploads')
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true })

export const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadsDir),
    filename: (req, file, cb) => {
      const ext = file.originalname.split('.').pop()
      cb(null, `banner_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.${ext}`)
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/^image\/(jpeg|png|gif|webp)$/.test(file.mimetype)) cb(null, true)
    else cb(new Error('Only image files are allowed'))
  },
})

// Evidence uploads for inhouse reports: images and short video clips, up to
// 50MB each. Filenames are namespaced `evidence_*` and served from /uploads
// like every other upload. The per-route `.array()` cap bounds how many.
const EVIDENCE_MAX_BYTES = 50 * 1024 * 1024
export const EVIDENCE_MAX_FILES = 5
export const uploadEvidence = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadsDir),
    filename: (req, file, cb) => {
      // Keep a safe extension only; never trust the rest of originalname.
      const ext = (file.originalname.split('.').pop() || 'bin').replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) || 'bin'
      cb(null, `evidence_${Date.now()}_${crypto.randomBytes(6).toString('hex')}.${ext}`)
    },
  }),
  limits: { fileSize: EVIDENCE_MAX_BYTES, files: EVIDENCE_MAX_FILES },
  fileFilter: (req, file, cb) => {
    if (/^(image\/(jpeg|png|gif|webp)|video\/(mp4|webm|quicktime))$/.test(file.mimetype)) cb(null, true)
    else cb(new Error('Only image (jpeg, png, gif, webp) or video (mp4, webm, mov) files are allowed'))
  },
})
