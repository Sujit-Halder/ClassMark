export const DEFAULT_APPEARANCE = { theme: 'system', font: 'dm-sans' }

export function applyAppearance(settings = DEFAULT_APPEARANCE) {
  const theme = ['light', 'dark', 'system'].includes(settings.theme) ? settings.theme : 'system'
  const font = ['dm-sans', 'system', 'serif'].includes(settings.font) ? settings.font : 'dm-sans'
  const resolved = theme === 'system'
    ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    : theme
  document.documentElement.dataset.themePreference = theme
  document.documentElement.dataset.theme = resolved
  document.documentElement.dataset.font = font
}

export function watchSystemAppearance(getSettings) {
  const query = window.matchMedia('(prefers-color-scheme: dark)')
  const update = () => {
    const settings = getSettings()
    if (settings?.theme === 'system') applyAppearance(settings)
  }
  query.addEventListener?.('change', update)
  return () => query.removeEventListener?.('change', update)
}
