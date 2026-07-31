import { createRoot } from 'react-dom/client'
import './index.css'
import TennisPairingApp from './TennisPairingApp.jsx'
import { firebaseStorage } from './firebaseStorage.js'

// The app talks to window.storage everywhere - this is the only wiring needed
// to point it at Firebase instead of Claude's artifact storage.
window.storage = firebaseStorage
// Tells the app it's running outside claude.ai, so it hides the GroupMe AI-extraction
// button (which relies on artifact-only authentication and can't work here).
window.__CC_STANDALONE__ = true

createRoot(document.getElementById('root')).render(<TennisPairingApp />)
