import { useEffect, useRef, useState } from 'react'
import { Camera, CameraOff, QrCode } from 'lucide-react'
import '../../styles/qr-scanner.css'

export default function QrCameraScanner({ onScan, disabled }) {
  const scannerRef = useRef(null)
  const [regionId] = useState(() => `qr-reader-${crypto.randomUUID()}`)
  const [active, setActive] = useState(false)
  const [error, setError] = useState('')

  async function stop() {
    const scanner = scannerRef.current
    scannerRef.current = null
    if (scanner) {
      try { if (scanner.isScanning) await scanner.stop() } catch { /* Camera may already be stopped. */ }
      try { scanner.clear() } catch { /* Reader may already be cleared. */ }
    }
    setActive(false)
  }

  async function start() {
    setError('')
    try {
      const { Html5Qrcode, Html5QrcodeSupportedFormats } = await import('html5-qrcode')
      const scanner = new Html5Qrcode(regionId, { formatsToSupport: [Html5QrcodeSupportedFormats.QR_CODE], verbose: false })
      scannerRef.current = scanner
      setActive(true)
      await scanner.start(
        { facingMode: 'environment' },
        { fps: 10, qrbox: (width, height) => ({ width: Math.min(260, width * .75), height: Math.min(260, height * .75) }) },
        async (decodedText) => { await stop(); onScan(decodedText) },
        () => {},
      )
    } catch (scanError) {
      await stop()
      const insecure = !window.isSecureContext && location.hostname !== 'localhost'
      setError(insecure ? 'Camera access requires HTTPS on a phone or LAN device.' : (scanError?.message || 'Could not open the camera. Check camera permission.'))
    }
  }

  useEffect(() => () => { const scanner=scannerRef.current; if(scanner?.isScanning) scanner.stop().catch(()=>{}) }, [])

  return <div className="qr-camera-scanner">
    <div className="scanner-region"><div id={regionId}/>{!active && <div className="scanner-placeholder"><QrCode/><span>Place the teacher’s QR code inside the camera frame.</span></div>}</div>
    <button type="button" className={active ? 'outline' : 'primary'} onClick={active ? stop : start} disabled={disabled}>{active ? <><CameraOff/>Stop camera</> : <><Camera/>Scan QR with camera</>}</button>
    {error && <p className="error">{error}</p>}
  </div>
}
