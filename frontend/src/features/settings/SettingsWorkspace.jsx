import { useEffect, useMemo, useRef, useState } from 'react'
import { Bell, Camera, Check, Eye, EyeOff, Laptop, LockKeyhole, Moon, Palette, ShieldCheck, Sun, Trash2, UserRound } from 'lucide-react'
import { applyAppearance } from '../../lib/appearance.js'
import '../../styles/settings-page.css'

const API = import.meta.env.VITE_API_URL || '/api'
const initialSettings = { theme: 'system', font: 'dm-sans', emailNotifications: true, attendanceNotifications: true, invitationNotifications: true }

async function request(path, options = {}) {
  const response = await fetch(`${API}${path}`, { ...options, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.token}`, ...options.headers } })
  const data = response.status === 204 ? {} : await response.json().catch(() => ({}))
  if (!response.ok) throw Error(data.message || 'Request failed.')
  return data
}

function passwordScore(value) {
  return [value.length >= 12, /[a-z]/.test(value), /[A-Z]/.test(value), /\d/.test(value), /[^A-Za-z0-9]/.test(value)].filter(Boolean).length
}

function SecretField({ label, name, value, onChange, visible, toggle, autoComplete }) {
  return <label>{label}<span className="secret-input"><input type={visible ? 'text' : 'password'} name={name} value={value} onChange={onChange} autoComplete={autoComplete} required/><button type="button" onClick={toggle} aria-label={visible ? 'Hide password' : 'Show password'}>{visible ? <EyeOff/> : <Eye/>}</button></span></label>
}

export default function SettingsWorkspace({ user, onUserUpdated }) {
  const [section, setSection] = useState('profile')
  const [form, setForm] = useState({ name: user.name || '', department: user.department || '', identifier: user.identifier || '', ...initialSettings })
  const [photo, setPhoto] = useState('')
  const [pendingPhoto, setPendingPhoto] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [processing, setProcessing] = useState('')
  const [passwords, setPasswords] = useState({ currentPassword: '', newPassword: '', confirmPassword: '' })
  const [visible, setVisible] = useState({ currentPassword: false, newPassword: false, confirmPassword: false })
  const photoUrl = useRef('')
  const score = useMemo(() => passwordScore(passwords.newPassword), [passwords.newPassword])
  const idLabel = user.role === 'teacher' ? 'Faculty ID' : 'Student ID / enrollment ID'

  useEffect(() => {
    let active = true
    Promise.all([request('/profile'), request('/settings')]).then(([profile, settings]) => {
      if (!active) return
      setForm(current => ({ ...current, ...profile, ...settings }))
      applyAppearance(settings)
    }).catch(error => active && setMessage(error.message))
    fetch(`${API}/profile/picture/${user.id}`, { headers: { Authorization: `Bearer ${localStorage.token}` } }).then(async response => {
      if (!response.ok) return
      const url = URL.createObjectURL(await response.blob())
      if (!active) return URL.revokeObjectURL(url)
      photoUrl.current = url
      setPhoto(url)
    }).catch(() => {})
    return () => { active = false; if (photoUrl.current) URL.revokeObjectURL(photoUrl.current) }
  }, [user.id])

  function change(event) {
    const { name, value, type, checked } = event.target
    const next = { ...form, [name]: type === 'checkbox' ? checked : value }
    setForm(next)
    if (name === 'theme' || name === 'font') applyAppearance(next)
  }

  function choosePhoto(event) {
    const file = event.target.files?.[0]
    if (!file) return
    if (file.size > 2_000_000) return setMessage('Profile picture must be under 2 MB.')
    const reader = new FileReader()
    reader.onload = () => { setPhoto(reader.result); setPendingPhoto(reader.result); setMessage('Picture selected. Save changes to upload it.') }
    reader.readAsDataURL(file)
  }

  async function removePhoto() {
    if (!photo && !pendingPhoto) return
    if (!window.confirm('Remove your profile picture?')) return
    setBusy(true); setProcessing('Removing your profile picture…'); setMessage('')
    try {
      await request('/profile/picture', { method: 'DELETE' })
      setPhoto(''); setPendingPhoto(''); setMessage('Your profile picture has been removed.'); window.dispatchEvent(new Event('profile-picture-updated'))
    } catch (error) { setMessage(error.message) } finally { setBusy(false); setProcessing('') }
  }

  async function save() {
    setBusy(true); setProcessing(pendingPhoto ? 'Uploading your photo and saving changes…' : 'Saving your preferences…'); setMessage('')
    try {
      const [updated] = await Promise.all([
        request('/profile', { method: 'PUT', body: JSON.stringify(form) }),
        request('/settings', { method: 'PUT', body: JSON.stringify(form) }),
        ...(pendingPhoto ? [request('/profile/picture', { method: 'PUT', body: JSON.stringify({ image: pendingPhoto }) })] : [])
      ])
      setPendingPhoto(''); applyAppearance(form); onUserUpdated?.(updated); window.dispatchEvent(new Event('profile-picture-updated')); setMessage('All changes have been saved successfully.')
    } catch (error) { setMessage(error.message) } finally { setBusy(false); setProcessing('') }
  }

  async function changePassword(event) {
    event.preventDefault(); setMessage('')
    if (passwords.newPassword !== passwords.confirmPassword) return setMessage('New password and confirmation do not match.')
    setBusy(true); setProcessing('Updating your password securely…')
    try {
      const result = await request('/account/password', { method: 'PUT', body: JSON.stringify(passwords) })
      setPasswords({ currentPassword: '', newPassword: '', confirmPassword: '' }); setMessage(result.message || 'Your password has been updated successfully.')
    } catch (error) { setMessage(error.message) } finally { setBusy(false); setProcessing('') }
  }

  const navigation = [
    ['profile', UserRound, 'Profile'], ['appearance', Palette, 'Appearance'], ['notifications', Bell, 'Notifications'], ['security', ShieldCheck, 'Security']
  ]
  return <div className="settings-page">
    <header className="settings-hero"><div><small>PREFERENCES</small><h1>Settings</h1><p>Personalize Classmark and keep your account secure.</p></div><span className="settings-saved"><Check/> Stored securely in SQLite</span></header>
    <div className="settings-shell">
      <aside className="settings-nav">{navigation.map(([key, Icon, label]) => <button key={key} className={section === key ? 'active' : ''} onClick={() => setSection(key)}><Icon/><span>{label}</span></button>)}</aside>
      <section className={`settings-content ${busy ? 'is-processing' : ''}`} aria-busy={busy}>
        {processing && <div className="settings-processing" role="status" aria-live="polite"><span className="settings-spinner"/><div><b>Please wait</b><small>{processing}</small></div></div>}
        {section === 'profile' && <><div className="settings-heading"><div><h2>Profile information</h2><p>Keep your identity details current across classrooms.</p></div></div><div className="photo-editor"><label className="large-profile-photo">{photo ? <img src={photo} alt="Profile"/> : <Camera/>}<input type="file" accept="image/png,image/jpeg,image/webp" onChange={choosePhoto}/></label><div><h3>Profile picture</h3><p>JPG, PNG or WebP · maximum 2 MB</p><div className="photo-actions"><label className="outline upload-button">Choose photo<input type="file" accept="image/png,image/jpeg,image/webp" onChange={choosePhoto}/></label>{photo && <button className="danger-link" onClick={removePhoto} disabled={busy}><Trash2/> Remove</button>}</div></div></div><div className="form-grid"><label>Full name<input name="name" value={form.name} onChange={change} required/></label><label>Email address<input value={form.email || user.email || ''} disabled/></label><label>Department<input name="department" value={form.department || ''} onChange={change} placeholder="Computer Science"/></label><label>{idLabel}<input name="identifier" value={form.identifier || ''} onChange={change} placeholder={user.role === 'teacher' ? 'FAC-1042' : 'STU-1042'}/></label><label>Account role<input value={user.role === 'teacher' ? 'Teacher' : 'Student'} disabled/></label></div></>}
        {section === 'appearance' && <><div className="settings-heading"><div><h2>Appearance</h2><p>Changes preview immediately and apply throughout Classmark.</p></div></div><h3 className="choice-label">Theme</h3><div className="choice-grid">{[['light', Sun, 'Light', 'Bright and clear'], ['dark', Moon, 'Dark', 'Easy on the eyes'], ['system', Laptop, 'System', 'Match this device']].map(([value, Icon, title, copy]) => <button key={value} className={`choice-card ${form.theme === value ? 'selected' : ''}`} name="theme" onClick={() => change({ target: { name: 'theme', value, type: 'button' } })}><span><Icon/></span><b>{title}</b><small>{copy}</small>{form.theme === value && <Check className="choice-check"/>}</button>)}</div><h3 className="choice-label">Interface font</h3><div className="font-grid">{[['dm-sans', 'Aa', 'DM Sans', 'Modern and friendly'], ['system', 'Ag', 'System', 'Native to your device'], ['serif', 'Aa', 'Serif', 'Traditional and focused']].map(([value, sample, title, copy]) => <button key={value} data-font-preview={value} className={`font-card ${form.font === value ? 'selected' : ''}`} onClick={() => change({ target: { name: 'font', value, type: 'button' } })}><strong>{sample}</strong><span><b>{title}</b><small>{copy}</small></span>{form.font === value && <Check/>}</button>)}</div><div className="appearance-preview"><small>LIVE PREVIEW</small><h3>Attendance, beautifully organized.</h3><p>Your selected font and theme now style the dashboard, classrooms, attendance tools, and settings.</p></div></>}
        {section === 'notifications' && <><div className="settings-heading"><div><h2>Notifications</h2><p>Choose which updates appear in your notification center and browser alerts.</p></div></div><div className="notification-list">{[['emailNotifications','Classroom activity','New announcements, assignments, and shared resources.'],['attendanceNotifications','Attendance results','Your final present or absent result when a session closes.'],['invitationNotifications','Class invitations','New teacher and student classroom invitations.']].map(([name,title,copy]) => <label className="notification-row" key={name}><span><b>{title}</b><small>{copy}</small></span><input type="checkbox" name={name} checked={Boolean(form[name])} onChange={change}/></label>)}</div></>}
        {section === 'security' && <><div className="settings-heading"><div><h2>Password & security</h2><p>Use a unique password that you do not use elsewhere.</p></div><LockKeyhole/></div><form className="password-form" onSubmit={changePassword}><SecretField label="Current password" name="currentPassword" value={passwords.currentPassword} onChange={e => setPasswords(p => ({ ...p, currentPassword: e.target.value }))} visible={visible.currentPassword} toggle={() => setVisible(v => ({ ...v, currentPassword: !v.currentPassword }))} autoComplete="current-password"/><SecretField label="New password" name="newPassword" value={passwords.newPassword} onChange={e => setPasswords(p => ({ ...p, newPassword: e.target.value }))} visible={visible.newPassword} toggle={() => setVisible(v => ({ ...v, newPassword: !v.newPassword }))} autoComplete="new-password"/><div className="password-meter"><span>{[1,2,3,4,5].map(i => <i key={i} className={score >= i ? `level-${score}` : ''}/>)}</span><small>{!passwords.newPassword ? '12+ characters with upper, lower, number and symbol' : score < 3 ? 'Weak password' : score < 5 ? 'Almost there' : 'Strong password'}</small></div><SecretField label="Confirm new password" name="confirmPassword" value={passwords.confirmPassword} onChange={e => setPasswords(p => ({ ...p, confirmPassword: e.target.value }))} visible={visible.confirmPassword} toggle={() => setVisible(v => ({ ...v, confirmPassword: !v.confirmPassword }))} autoComplete="new-password"/><button className="primary password-submit" disabled={busy || score < 5}>Update password</button></form></>}
        {message && <div role="status" aria-live="polite" className={`settings-message ${/saved|success|removed|updated/i.test(message) ? 'success' : 'error'}`}>{/saved|success|removed|updated/i.test(message) ? <Check/> : <ShieldCheck/>}<span>{message}</span><button type="button" onClick={() => setMessage('')} aria-label="Dismiss message">×</button></div>}
        {section !== 'security' && <footer className="settings-footer"><button className="primary" onClick={save} disabled={busy}><Check/>{busy ? 'Saving…' : 'Save changes'}</button></footer>}
      </section>
    </div>
  </div>
}
