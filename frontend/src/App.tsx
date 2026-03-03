// import CaretakerPortal from './features/caretaker/CaretakerPortal'
// import { useState, type FormEvent } from 'react'
// import { VoiceRecorder } from './components/VoiceRecorder'
// import './App.css'

// interface Question {
//   id: number
//   text: string
// }

// interface FormErrors {
//   userName?: string
//   userPhone?: string
//   contactName?: string
//   contactPhone?: string
//   relationship?: string
//   questions?: string
// }

// function App() {

//   const portal = new URLSearchParams(window.location.search).get('portal')
//   if (portal === 'caretaker') {
//     return <CaretakerPortal />
//   }
//   const [userName, setUserName] = useState('')
//   const [userPhone, setUserPhone] = useState('')
//   const [contactName, setContactName] = useState('')
//   const [contactPhone, setContactPhone] = useState('')
//   const [relationship, setRelationship] = useState('')
//   const [questions, setQuestions] = useState<Question[]>([])
//   const [newQuestion, setNewQuestion] = useState('')
//   const [errors, setErrors] = useState<FormErrors>({})
//   const [submitted, setSubmitted] = useState(false)
//   const [nextId, setNextId] = useState(1)
//   const [callStatus, setCallStatus] = useState<'idle' | 'calling' | 'success' | 'error'>('idle')
//   const [callError, setCallError] = useState('')

//   const handleCall = async () => {
//     const digits = contactPhone.replace(/\D/g, '')
//     if (digits.length < 9) {
//       setCallError('Enter a valid phone number first')
//       return
//     }

//     setCallStatus('calling')
//     setCallError('')

//     try {
//       const res = await fetch('/api/call', {
//         method: 'POST',
//         headers: { 'Content-Type': 'application/json' },
//         body: JSON.stringify({
//           phoneNumber: contactPhone,
//           contactName,
//           relationship,
//           questions: questions.map(q => ({ id: q.id, text: q.text })),
//         }),
//       })
//       const data = await res.json()

//       if (!res.ok) throw new Error(data.error || 'Call failed')

//       setCallStatus('success')
//       setTimeout(() => setCallStatus('idle'), 4000)
//     } catch (err: unknown) {
//       setCallStatus('error')
//       setCallError(err instanceof Error ? err.message : 'Call failed')
//       setTimeout(() => setCallStatus('idle'), 4000)
//     }
//   }

//   const formatPhone = (value: string): string => {
//     const digits = value.replace(/\D/g, '')
//     if (digits.length <= 3) return digits
//     if (digits.length <= 6) return `(${digits.slice(0, 3)}) ${digits.slice(3)}`
//     return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6, 10)}`
//   }

//   const handlePhoneChange = (
//     value: string,
//     setter: (v: string) => void
//   ) => {
//     setter(formatPhone(value))
//   }

//   const addQuestion = () => {
//     const trimmed = newQuestion.trim()
//     if (!trimmed) return
//     setQuestions(prev => [...prev, { id: nextId, text: trimmed }])
//     setNextId(prev => prev + 1)
//     setNewQuestion('')
//   }

//   const removeQuestion = (id: number) => {
//     setQuestions(prev => prev.filter(q => q.id !== id))
//   }

//   const moveQuestion = (index: number, direction: 'up' | 'down') => {
//     const newIndex = direction === 'up' ? index - 1 : index + 1
//     if (newIndex < 0 || newIndex >= questions.length) return
//     const updated = [...questions]
//     const temp = updated[index]
//     updated[index] = updated[newIndex]
//     updated[newIndex] = temp
//     setQuestions(updated)
//   }

//   const validate = (): FormErrors => {
//     const errs: FormErrors = {}
//     if (!userName.trim()) errs.userName = 'Name is required'
//     const userDigits = userPhone.replace(/\D/g, '')
//     if (!userDigits) errs.userPhone = 'Phone number is required'
//     else if (userDigits.length < 10) errs.userPhone = 'Enter a valid 10-digit phone number'

//     if (!contactName.trim()) errs.contactName = 'Name is required'
//     const contactDigits = contactPhone.replace(/\D/g, '')
//     if (!contactDigits) errs.contactPhone = 'Phone number is required'
//     else if (contactDigits.length < 10) errs.contactPhone = 'Enter a valid 10-digit phone number'

//     if (!relationship) errs.relationship = 'Please select a relationship'
//     if (questions.length === 0) errs.questions = 'Add at least one question'

//     return errs
//   }

//   const handleSubmit = (e: FormEvent) => {
//     e.preventDefault()
//     const errs = validate()
//     setErrors(errs)
//     if (Object.keys(errs).length === 0) {
//       setSubmitted(true)
//     }
//   }

//   const handleReset = () => {
//     setUserName('')
//     setUserPhone('')
//     setContactName('')
//     setContactPhone('')
//     setRelationship('')
//     setQuestions([])
//     setNewQuestion('')
//     setErrors({})
//     setSubmitted(false)
//     setNextId(1)
//     setCallStatus('idle')
//     setCallError('')
//   }

  

//   if (submitted) {
//     return (
//       <div className="page-wrapper">
//         <div className="success-card">
//           <div className="success-icon">
//             <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
//               <path d="M20 6L9 17l-5-5" />
//             </svg>
//           </div>
//           <h2 className="success-title">Submitted Successfully</h2>
//           <p className="success-text">
//             Your information and questions for <strong>{contactName}</strong> have been recorded.
//           </p>
//           <button type="button" className="btn btn-primary" onClick={handleReset}>
//             Submit Another
//           </button>
//         </div>
//       </div>
//     )
//   }

//   return (
//     <div className="page-wrapper">
//       <header className="page-header">
//         <div className="header-accent" />
//         <h1 className="page-title">Contact Interview</h1>
//         <p className="page-subtitle">
//           Fill in your details and prepare your questions
//         </p>
//       </header>

//       <form onSubmit={handleSubmit} noValidate>
//         {/* Section 1: User Information */}
//         <section className="form-card" style={{ animationDelay: '0.1s' }}>
//           <div className="card-header">
//             <span className="card-number">01</span>
//             <div>
//               <h2 className="card-title">Your Information</h2>
//               <p className="card-description">Tell us about yourself</p>
//             </div>
//           </div>

//           <div className="form-grid">
//             <div className={`form-group ${errors.userName ? 'has-error' : ''}`}>
//               <label htmlFor="userName" className="form-label">
//                 Full Name <span className="required">*</span>
//               </label>
//               <input
//                 id="userName"
//                 type="text"
//                 className="form-input"
//                 placeholder="John Doe"
//                 value={userName}
//                 onChange={e => setUserName(e.target.value)}
//               />
//               {errors.userName && <span className="error-text">{errors.userName}</span>}
//             </div>

//             <div className={`form-group ${errors.userPhone ? 'has-error' : ''}`}>
//               <label htmlFor="userPhone" className="form-label">
//                 Phone Number <span className="required">*</span>
//               </label>
//               <input
//                 id="userPhone"
//                 type="tel"
//                 className="form-input"
//                 placeholder="(555) 123-4567"
//                 value={userPhone}
//                 onChange={e => handlePhoneChange(e.target.value, setUserPhone)}
//                 maxLength={14}
//               />
//               {errors.userPhone && <span className="error-text">{errors.userPhone}</span>}
//             </div>
//           </div>
//         </section>

//         {/* Section 2: Contact Person */}
//         <section className="form-card" style={{ animationDelay: '0.25s' }}>
//           <div className="card-header">
//             <span className="card-number">02</span>
//             <div>
//               <h2 className="card-title">Contact Person</h2>
//               <p className="card-description">Who would you like to reach out to?</p>
//             </div>
//           </div>

//           <div className="form-grid">
//             <div className={`form-group ${errors.contactName ? 'has-error' : ''}`}>
//               <label htmlFor="contactName" className="form-label">
//                 Full Name <span className="required">*</span>
//               </label>
//               <input
//                 id="contactName"
//                 type="text"
//                 className="form-input"
//                 placeholder="Jane Smith"
//                 value={contactName}
//                 onChange={e => setContactName(e.target.value)}
//               />
//               {errors.contactName && <span className="error-text">{errors.contactName}</span>}
//             </div>

//             <div className={`form-group ${errors.contactPhone ? 'has-error' : ''}`}>
//               <label htmlFor="contactPhone" className="form-label">
//                 Phone Number <span className="required">*</span>
//               </label>
//               <input
//                 id="contactPhone"
//                 type="tel"
//                 className="form-input"
//                 placeholder="(555) 987-6543"
//                 value={contactPhone}
//                 onChange={e => handlePhoneChange(e.target.value, setContactPhone)}
//                 maxLength={14}
//               />
//               {errors.contactPhone && <span className="error-text">{errors.contactPhone}</span>}
//             </div>
//           </div>

//           <div className="call-action-row">
//             <button
//               type="button"
//               className={`btn btn-call ${callStatus}`}
//               onClick={handleCall}
//               disabled={callStatus === 'calling'}
//             >
//               {callStatus === 'calling' ? (
//                 <>
//                   <svg className="spinner" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18">
//                     <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
//                   </svg>
//                   Calling...
//                 </>
//               ) : callStatus === 'success' ? (
//                 <>
//                   <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18">
//                     <path d="M20 6L9 17l-5-5" />
//                   </svg>
//                   Call Initiated
//                 </>
//               ) : (
//                 <>
//                   <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" width="18" height="18">
//                     <path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6 19.79 19.79 0 01-3.07-8.67A2 2 0 014.11 2h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 16.92z" />
//                   </svg>
//                   Call {contactName || 'Contact'}
//                 </>
//               )}
//             </button>
//             {callStatus === 'error' && callError && (
//               <span className="error-text">{callError}</span>
//             )}
//           </div>

//           <div className={`form-group ${errors.relationship ? 'has-error' : ''}`}>
//             <label htmlFor="relationship" className="form-label">
//               Relationship <span className="required">*</span>
//             </label>
//             <div className="select-wrapper">
//               <select
//                 id="relationship"
//                 className="form-select"
//                 value={relationship}
//                 onChange={e => setRelationship(e.target.value)}
//               >
//                 <option value="" disabled>Choose relationship...</option>
//                 <option value="parent">Parent</option>
//                 <option value="sibling">Sibling</option>
//                 <option value="spouse">Spouse</option>
//                 <option value="friend">Friend</option>
//                 <option value="colleague">Colleague</option>
//                 <option value="other">Other</option>
//               </select>
//               <svg className="select-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
//                 <path d="M6 9l6 6 6-6" />
//               </svg>
//             </div>
//             {errors.relationship && <span className="error-text">{errors.relationship}</span>}
//           </div>

//           {/* Questions List */}
//           <div className={`form-group questions-section ${errors.questions ? 'has-error' : ''}`}>
//             <label className="form-label">
//               Questions to Ask <span className="required">*</span>
//             </label>
//             <p className="field-hint">Prepare the questions you'd like to ask this person</p>

//             {questions.length > 0 && (
//               <ul className="questions-list">
//                 {questions.map((q, index) => (
//                   <li key={q.id} className="question-item">
//                     <span className="question-number">{index + 1}</span>
//                     <span className="question-text">{q.text}</span>
//                     <div className="question-actions">
//                       <button
//                         type="button"
//                         className="btn-icon"
//                         onClick={() => moveQuestion(index, 'up')}
//                         disabled={index === 0}
//                         title="Move up"
//                         aria-label="Move question up"
//                       >
//                         <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 15l-6-6-6 6" /></svg>
//                       </button>
//                       <button
//                         type="button"
//                         className="btn-icon"
//                         onClick={() => moveQuestion(index, 'down')}
//                         disabled={index === questions.length - 1}
//                         title="Move down"
//                         aria-label="Move question down"
//                       >
//                         <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 9l6 6 6-6" /></svg>
//                       </button>
//                       <button
//                         type="button"
//                         className="btn-icon btn-icon-danger"
//                         onClick={() => removeQuestion(q.id)}
//                         title="Remove question"
//                         aria-label="Remove question"
//                       >
//                         <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12" /></svg>
//                       </button>
//                     </div>
//                   </li>
//                 ))}
//               </ul>
//             )}

//             <div className="add-question-row">
//               <div className="add-question-input">
//                 <input
//                   type="text"
//                   className="form-input"
//                   placeholder="Type a question..."
//                   value={newQuestion}
//                   onChange={e => setNewQuestion(e.target.value)}
//                   onKeyDown={e => {
//                     if (e.key === 'Enter') {
//                       e.preventDefault()
//                       addQuestion()
//                     }
//                   }}
//                 />
//               </div>
//               <button
//                 type="button"
//                 className="btn btn-secondary"
//                 onClick={addQuestion}
//               >
//                 <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" width="18" height="18">
//                   <path d="M12 5v14M5 12h14" />
//                 </svg>
//                 Add
//               </button>
//             </div>
//             {errors.questions && <span className="error-text">{errors.questions}</span>}
//           </div>
//         </section>

//         {/* Section 3: Voice Recorder */}
//         <section className="form-card" style={{ animationDelay: '0.4s' }}>
//           <div className="card-header">
//             <span className="card-number">03</span>
//             <div>
//               <h2 className="card-title">Voice Recorder</h2>
//               <p className="card-description">Record a voice message — transcribed in real time</p>
//             </div>
//           </div>
//           <VoiceRecorder />
//         </section>

//         {/* Submit */}
//         <div className="form-actions" style={{ animationDelay: '0.55s' }}>
//           <button type="submit" className="btn btn-primary btn-large">
//             Submit Form
//             <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="20" height="20">
//               <path d="M5 12h14M12 5l7 7-7 7" />
//             </svg>
//           </button>
//         </div>
//       </form>
//     </div>
//   )
// }

// export default App

import CaretakerPortal from './features/caretaker/CaretakerPortal'
import { useState, type FormEvent } from 'react'
import { jsPDF } from 'jspdf'
import { VoiceRecorder } from './components/VoiceRecorder'
import './App.css'

interface Question {
  id: number
  text: string
}

interface FormErrors {
  userName?: string
  userPhone?: string
  contactName?: string
  contactPhone?: string
  relationship?: string
  questions?: string
}

/**
 * ✅ App is hook-safe (no conditional hooks).
 * It only chooses which portal component to render.
 */
function App() {
  const portal = new URLSearchParams(window.location.search).get('portal')
  return portal === 'caretaker' ? <CaretakerPortal /> : <PatientPortal />
}

/**
 * ✅ All your existing patient portal code (hooks + UI) lives here unchanged.
 */
function PatientPortal() {
  const [userName, setUserName] = useState('')
  const [userPhone, setUserPhone] = useState('')
  const [contactName, setContactName] = useState('')
  const [contactPhone, setContactPhone] = useState('')
  const [relationship, setRelationship] = useState('')
  const [questions, setQuestions] = useState<Question[]>([])
  const [newQuestion, setNewQuestion] = useState('')
  const [errors, setErrors] = useState<FormErrors>({})
  const [submitted, setSubmitted] = useState(false)
  const [nextId, setNextId] = useState(1)
  const [callStatus, setCallStatus] = useState<'idle' | 'calling' | 'success' | 'error'>('idle')
  const [callError, setCallError] = useState('')
  const [downloading, setDownloading] = useState(false)

  const handleDownload = async () => {
    setDownloading(true)
    try {
      const res = await fetch('/api/caretaker/transcripts')
      const data = await res.json()
      const transcripts = data.transcripts || []

      if (transcripts.length === 0) {
        alert('No conversations found.')
        return
      }

      const pdf = new jsPDF({ unit: 'mm', format: 'a4' })
      const W = pdf.internal.pageSize.getWidth()
      const H = pdf.internal.pageSize.getHeight()
      const margin = 20
      const contentW = W - margin * 2
      let y = 0

      const ensureSpace = (needed: number) => {
        if (y + needed > H - margin) {
          pdf.addPage()
          y = margin
        }
      }

      // Header
      pdf.setFillColor(45, 74, 62)
      pdf.rect(0, 0, W, 52, 'F')
      pdf.setFillColor(196, 114, 78)
      pdf.rect(0, 52, W, 2, 'F')

      pdf.setFont('helvetica', 'bold')
      pdf.setFontSize(22)
      pdf.setTextColor(255, 255, 255)
      pdf.text('Conversation Transcripts', margin, 26)

      pdf.setFont('helvetica', 'normal')
      pdf.setFontSize(10)
      pdf.setTextColor(200, 210, 200)
      const dateStr = new Date().toLocaleDateString('en-GB', {
        day: 'numeric', month: 'long', year: 'numeric',
      })
      pdf.text(`${dateStr}  \u2022  ${transcripts.length} session${transcripts.length !== 1 ? 's' : ''}`, margin, 38)

      y = 66

      transcripts.forEach((session: any, idx: number) => {
        ensureSpace(25)

        // Session header
        pdf.setFillColor(245, 243, 240)
        pdf.roundedRect(margin, y - 3, contentW, 14, 3, 3, 'F')
        pdf.setFillColor(196, 114, 78)
        pdf.roundedRect(margin, y - 3, 3, 14, 1.5, 1.5, 'F')

        pdf.setFont('helvetica', 'bold')
        pdf.setFontSize(12)
        pdf.setTextColor(45, 74, 62)

        const md = session.metadata_ || {}
        const sessionData = md.data || {}
        const title = sessionData.date
          ? `Call Session — ${sessionData.day || ''} ${sessionData.date} at ${sessionData.time || ''}`
          : `Session ${idx + 1}`
        pdf.text(title, margin + 8, y + 6)

        y += 18

        // Content (transcript text)
        const content = session.content || ''
        if (content) {
          const lines = pdf.setFont('helvetica', 'normal').setFontSize(10).splitTextToSize(content, contentW - 14)
          const blockH = lines.length * 5 + 7
          ensureSpace(blockH + 4)

          pdf.setFillColor(250, 248, 245)
          pdf.setDrawColor(230, 225, 220)
          pdf.roundedRect(margin, y - 3, contentW, blockH, 2.5, 2.5, 'FD')

          pdf.setTextColor(60, 55, 50)
          pdf.text(lines, margin + 7, y + 3.5)
          y += blockH + 5
        }

        if (idx < transcripts.length - 1) {
          y += 6
          ensureSpace(8)
          pdf.setDrawColor(220, 215, 210)
          pdf.setLineWidth(0.3)
          pdf.line(margin + 30, y, W - margin - 30, y)
          y += 10
        }
      })

      // Footer
      pdf.setFont('helvetica', 'normal')
      pdf.setFontSize(7)
      pdf.setTextColor(160, 155, 150)
      pdf.text('Dementia Voice Agent  \u2022  Confidential', W / 2, H - 10, { align: 'center' })

      pdf.save('conversation-transcripts.pdf')
    } catch (err) {
      console.error('Download failed:', err)
      alert('Failed to download transcripts. Check console for details.')
    } finally {
      setDownloading(false)
    }
  }

  const handleCall = async () => {
    const digits = contactPhone.replace(/\D/g, '')
    if (digits.length < 9) {
      setCallError('Enter a valid phone number first')
      return
    }

    setCallStatus('calling')
    setCallError('')

    try {
      const res = await fetch('/api/call', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phoneNumber: contactPhone,
          contactName,
          relationship,
          questions: questions.map(q => ({ id: q.id, text: q.text })),
        }),
      })
      const data = await res.json()

      if (!res.ok) throw new Error(data.error || 'Call failed')

      setCallStatus('success')
      setTimeout(() => setCallStatus('idle'), 4000)
    } catch (err: unknown) {
      setCallStatus('error')
      setCallError(err instanceof Error ? err.message : 'Call failed')
      setTimeout(() => setCallStatus('idle'), 4000)
    }
  }

  const formatPhone = (value: string): string => {
    const digits = value.replace(/\D/g, '')
    if (digits.length <= 3) return digits
    if (digits.length <= 6) return `(${digits.slice(0, 3)}) ${digits.slice(3)}`
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6, 10)}`
  }

  const handlePhoneChange = (value: string, setter: (v: string) => void) => {
    setter(formatPhone(value))
  }

  const addQuestion = () => {
    const trimmed = newQuestion.trim()
    if (!trimmed) return
    setQuestions(prev => [...prev, { id: nextId, text: trimmed }])
    setNextId(prev => prev + 1)
    setNewQuestion('')
  }

  const removeQuestion = (id: number) => {
    setQuestions(prev => prev.filter(q => q.id !== id))
  }

  const moveQuestion = (index: number, direction: 'up' | 'down') => {
    const newIndex = direction === 'up' ? index - 1 : index + 1
    if (newIndex < 0 || newIndex >= questions.length) return
    const updated = [...questions]
    const temp = updated[index]
    updated[index] = updated[newIndex]
    updated[newIndex] = temp
    setQuestions(updated)
  }

  const validate = (): FormErrors => {
    const errs: FormErrors = {}
    if (!userName.trim()) errs.userName = 'Name is required'
    const userDigits = userPhone.replace(/\D/g, '')
    if (!userDigits) errs.userPhone = 'Phone number is required'
    else if (userDigits.length < 10) errs.userPhone = 'Enter a valid 10-digit phone number'

    if (!contactName.trim()) errs.contactName = 'Name is required'
    const contactDigits = contactPhone.replace(/\D/g, '')
    if (!contactDigits) errs.contactPhone = 'Phone number is required'
    else if (contactDigits.length < 10) errs.contactPhone = 'Enter a valid 10-digit phone number'

    if (!relationship) errs.relationship = 'Please select a relationship'
    if (questions.length === 0) errs.questions = 'Add at least one question'

    return errs
  }

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault()
    const errs = validate()
    setErrors(errs)
    if (Object.keys(errs).length === 0) {
      setSubmitted(true)
    }
  }

  const handleReset = () => {
    setUserName('')
    setUserPhone('')
    setContactName('')
    setContactPhone('')
    setRelationship('')
    setQuestions([])
    setNewQuestion('')
    setErrors({})
    setSubmitted(false)
    setNextId(1)
    setCallStatus('idle')
    setCallError('')
  }

  if (submitted) {
    return (
      <div className="page-wrapper">
        <div className="success-card">
          <div className="success-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20 6L9 17l-5-5" />
            </svg>
          </div>
          <h2 className="success-title">Submitted Successfully</h2>
          <p className="success-text">
            Your information and questions for <strong>{contactName}</strong> have been recorded.
          </p>

          <div style={{ marginTop: 12, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <button type="button" className="btn btn-primary" onClick={handleReset}>
              Submit Another
            </button>

            {/* Optional: link to caretaker portal */}
            <a className="btn btn-secondary" href="/?portal=caretaker">
              Caretaker portal →
            </a>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="page-wrapper">
      <header className="page-header">
        <div className="header-accent" />
        <h1 className="page-title">Contact Interview</h1>
        <p className="page-subtitle">
          Fill in your details and prepare your questions
        </p>

        {/* Optional: link to caretaker portal */}
        <div style={{ marginTop: 8 }}>
          <a href="/?portal=caretaker" style={{ fontSize: 12, opacity: 0.8 }}>
            Caretaker portal →
          </a>
        </div>
        <button
          type="button"
          className="btn-download"
          onClick={handleDownload}
          disabled={downloading}
        >
          {downloading ? (
            <>
              <svg className="spinner" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18">
                <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
              </svg>
              Downloading...
            </>
          ) : (
            <>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="18" height="18">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
              Download Transcripts
            </>
          )}
        </button>
      </header>

      <form onSubmit={handleSubmit} noValidate>
        {/* Section 1: User Information */}
        <section className="form-card" style={{ animationDelay: '0.1s' }}>
          <div className="card-header">
            <span className="card-number">01</span>
            <div>
              <h2 className="card-title">Your Information</h2>
              <p className="card-description">Tell us about yourself</p>
            </div>
          </div>

          <div className="form-grid">
            <div className={`form-group ${errors.userName ? 'has-error' : ''}`}>
              <label htmlFor="userName" className="form-label">
                Full Name <span className="required">*</span>
              </label>
              <input
                id="userName"
                type="text"
                className="form-input"
                placeholder="John Doe"
                value={userName}
                onChange={e => setUserName(e.target.value)}
              />
              {errors.userName && <span className="error-text">{errors.userName}</span>}
            </div>

            <div className={`form-group ${errors.userPhone ? 'has-error' : ''}`}>
              <label htmlFor="userPhone" className="form-label">
                Phone Number <span className="required">*</span>
              </label>
              <input
                id="userPhone"
                type="tel"
                className="form-input"
                placeholder="(555) 123-4567"
                value={userPhone}
                onChange={e => handlePhoneChange(e.target.value, setUserPhone)}
                maxLength={14}
              />
              {errors.userPhone && <span className="error-text">{errors.userPhone}</span>}
            </div>
          </div>
        </section>

        {/* Section 2: Contact Person */}
        <section className="form-card" style={{ animationDelay: '0.25s' }}>
          <div className="card-header">
            <span className="card-number">02</span>
            <div>
              <h2 className="card-title">Contact Person</h2>
              <p className="card-description">Who would you like to reach out to?</p>
            </div>
          </div>

          <div className="form-grid">
            <div className={`form-group ${errors.contactName ? 'has-error' : ''}`}>
              <label htmlFor="contactName" className="form-label">
                Full Name <span className="required">*</span>
              </label>
              <input
                id="contactName"
                type="text"
                className="form-input"
                placeholder="Jane Smith"
                value={contactName}
                onChange={e => setContactName(e.target.value)}
              />
              {errors.contactName && <span className="error-text">{errors.contactName}</span>}
            </div>

            <div className={`form-group ${errors.contactPhone ? 'has-error' : ''}`}>
              <label htmlFor="contactPhone" className="form-label">
                Phone Number <span className="required">*</span>
              </label>
              <input
                id="contactPhone"
                type="tel"
                className="form-input"
                placeholder="(555) 987-6543"
                value={contactPhone}
                onChange={e => handlePhoneChange(e.target.value, setContactPhone)}
                maxLength={14}
              />
              {errors.contactPhone && <span className="error-text">{errors.contactPhone}</span>}
            </div>
          </div>

          <div className="call-action-row">
            <button
              type="button"
              className={`btn btn-call ${callStatus}`}
              onClick={handleCall}
              disabled={callStatus === 'calling'}
            >
              {callStatus === 'calling' ? (
                <>
                  <svg className="spinner" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18">
                    <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
                  </svg>
                  Calling...
                </>
              ) : callStatus === 'success' ? (
                <>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18">
                    <path d="M20 6L9 17l-5-5" />
                  </svg>
                  Call Initiated
                </>
              ) : (
                <>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" width="18" height="18">
                    <path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6 19.79 19.79 0 01-3.07-8.67A2 2 0 014.11 2h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 16.92z" />
                  </svg>
                  Call {contactName || 'Contact'}
                </>
              )}
            </button>
            {callStatus === 'error' && callError && (
              <span className="error-text">{callError}</span>
            )}
          </div>

          <div className={`form-group ${errors.relationship ? 'has-error' : ''}`}>
            <label htmlFor="relationship" className="form-label">
              Relationship <span className="required">*</span>
            </label>
            <div className="select-wrapper">
              <select
                id="relationship"
                className="form-select"
                value={relationship}
                onChange={e => setRelationship(e.target.value)}
              >
                <option value="" disabled>Choose relationship...</option>
                <option value="parent">Parent</option>
                <option value="sibling">Sibling</option>
                <option value="spouse">Spouse</option>
                <option value="friend">Friend</option>
                <option value="colleague">Colleague</option>
                <option value="other">Other</option>
              </select>
              <svg className="select-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M6 9l6 6 6-6" />
              </svg>
            </div>
            {errors.relationship && <span className="error-text">{errors.relationship}</span>}
          </div>

          {/* Questions List */}
          <div className={`form-group questions-section ${errors.questions ? 'has-error' : ''}`}>
            <label className="form-label">
              Questions to Ask <span className="required">*</span>
            </label>
            <p className="field-hint">Prepare the questions you'd like to ask this person</p>

            {questions.length > 0 && (
              <ul className="questions-list">
                {questions.map((q, index) => (
                  <li key={q.id} className="question-item">
                    <span className="question-number">{index + 1}</span>
                    <span className="question-text">{q.text}</span>
                    <div className="question-actions">
                      <button
                        type="button"
                        className="btn-icon"
                        onClick={() => moveQuestion(index, 'up')}
                        disabled={index === 0}
                        title="Move up"
                        aria-label="Move question up"
                      >
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 15l-6-6-6 6" /></svg>
                      </button>
                      <button
                        type="button"
                        className="btn-icon"
                        onClick={() => moveQuestion(index, 'down')}
                        disabled={index === questions.length - 1}
                        title="Move down"
                        aria-label="Move question down"
                      >
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 9l6 6 6-6" /></svg>
                      </button>
                      <button
                        type="button"
                        className="btn-icon btn-icon-danger"
                        onClick={() => removeQuestion(q.id)}
                        title="Remove question"
                        aria-label="Remove question"
                      >
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12" /></svg>
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}

            <div className="add-question-row">
              <div className="add-question-input">
                <input
                  type="text"
                  className="form-input"
                  placeholder="Type a question..."
                  value={newQuestion}
                  onChange={e => setNewQuestion(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      addQuestion()
                    }
                  }}
                />
              </div>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={addQuestion}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" width="18" height="18">
                  <path d="M12 5v14M5 12h14" />
                </svg>
                Add
              </button>
            </div>
            {errors.questions && <span className="error-text">{errors.questions}</span>}
          </div>
        </section>

        {/* Section 3: Voice Recorder */}
        <section className="form-card" style={{ animationDelay: '0.4s' }}>
          <div className="card-header">
            <span className="card-number">03</span>
            <div>
              <h2 className="card-title">Voice Recorder</h2>
              <p className="card-description">Record a voice message — transcribed in real time</p>
            </div>
          </div>
          <VoiceRecorder />
        </section>

        {/* Submit */}
        <div className="form-actions" style={{ animationDelay: '0.55s' }}>
          <button type="submit" className="btn btn-primary btn-large">
            Submit Form
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="20" height="20">
              <path d="M5 12h14M12 5l7 7-7 7" />
            </svg>
          </button>
        </div>
      </form>
    </div>
  )
}

export default App
