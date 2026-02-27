import { useState, useRef, useCallback, useEffect } from 'react'
import { RealtimeClient } from '@speechmatics/real-time-client'
import { PCMRecorder } from '@speechmatics/browser-audio-input'
import type { InputAudioEvent } from '@speechmatics/browser-audio-input'
import PCMAudioWorkletUrl from '@speechmatics/browser-audio-input/pcm-audio-worklet.min.js?url'
import './VoiceRecorder.css'

type RecorderState =
  | 'idle'
  | 'connecting'
  | 'recording'
  | 'stopping'
  | 'uploading'
  | 'success'
  | 'error'

export function VoiceRecorder() {
  const [state, setState] = useState<RecorderState>('idle')
  const [elapsed, setElapsed] = useState(0)
  const [errorMsg, setErrorMsg] = useState('')
  const [partialTranscript, setPartialTranscript] = useState('')
  const [finalTranscript, setFinalTranscript] = useState('')

  const finalTranscriptRef = useRef('')
  const submittedRef = useRef(false)
  const clientRef = useRef<RealtimeClient | null>(null)
  const pcmRecorderRef = useRef<PCMRecorder | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const timerRef = useRef<ReturnType<typeof setInterval>>(null)
  const safetyTimeoutRef = useRef<ReturnType<typeof setTimeout>>(null)

  const cleanup = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
    if (safetyTimeoutRef.current) {
      clearTimeout(safetyTimeoutRef.current)
      safetyTimeoutRef.current = null
    }
    if (pcmRecorderRef.current?.isRecording) {
      pcmRecorderRef.current.stopRecording()
    }
    pcmRecorderRef.current = null
    if (audioContextRef.current) {
      audioContextRef.current.close().catch(() => {})
      audioContextRef.current = null
    }
    clientRef.current = null
  }, [])

  useEffect(() => {
    return cleanup
  }, [cleanup])

  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60)
      .toString()
      .padStart(2, '0')
    const s = (seconds % 60).toString().padStart(2, '0')
    return `${m}:${s}`
  }

  const submitTranscript = async (text: string) => {
    setState('uploading')
    try {
      const res = await fetch('/api/voice', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transcript: text }),
      })
      if (!res.ok) throw new Error(`Server responded with ${res.status}`)
      setState('success')
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : 'Failed to submit transcript',
      )
      setState('error')
    }
  }

  const handleEndOfTranscript = () => {
    if (submittedRef.current) return
    submittedRef.current = true

    if (safetyTimeoutRef.current) {
      clearTimeout(safetyTimeoutRef.current)
      safetyTimeoutRef.current = null
    }

    const transcript = finalTranscriptRef.current.trim()
    if (transcript) {
      submitTranscript(transcript)
    } else {
      setErrorMsg('No speech was detected. Please try again and speak clearly.')
      setState('error')
    }
  }

  const startRecording = async () => {
    setErrorMsg('')
    setPartialTranscript('')
    setFinalTranscript('')
    finalTranscriptRef.current = ''
    submittedRef.current = false
    setState('connecting')

    try {
      // 1. Fetch JWT from dev server endpoint
      const jwtRes = await fetch('/api/speechmatics/jwt')
      if (!jwtRes.ok) throw new Error('Failed to get authentication token')
      const { jwt } = (await jwtRes.json()) as { jwt: string }

      // 2. Create RealtimeClient and register event listener
      const client = new RealtimeClient()
      clientRef.current = client

      client.addEventListener('receiveMessage', (event) => {
        const msg = event.data
        if (msg.message === 'AddPartialTranscript') {
          setPartialTranscript(msg.metadata.transcript)
        } else if (msg.message === 'AddTranscript') {
          finalTranscriptRef.current += msg.metadata.transcript
          setFinalTranscript(finalTranscriptRef.current)
          setPartialTranscript('')
        } else if (msg.message === 'EndOfTranscript') {
          handleEndOfTranscript()
        }
      })

      // 3. Start recognition session over WebSocket
      await client.start(jwt, {
        transcription_config: {
          language: 'en',
          enable_partials: true,
          max_delay: 2,
        },
        audio_format: {
          type: 'raw',
          encoding: 'pcm_f32le',
          sample_rate: 16000,
        },
      })

      // 4. Set up audio capture pipeline
      const audioContext = new AudioContext({ sampleRate: 16000 })
      audioContextRef.current = audioContext

      const pcmRecorder = new PCMRecorder(PCMAudioWorkletUrl)
      pcmRecorderRef.current = pcmRecorder

      pcmRecorder.addEventListener('audio', (event: InputAudioEvent) => {
        client.sendAudio(event.data)
      })

      await pcmRecorder.startRecording({ audioContext })

      // 5. Start UI timer and update state
      setState('recording')
      setElapsed(0)
      timerRef.current = setInterval(() => {
        setElapsed((prev) => prev + 1)
      }, 1000)
    } catch (err) {
      cleanup()
      const msg =
        err instanceof DOMException && err.name === 'NotAllowedError'
          ? 'Microphone access denied. Please allow microphone permissions and try again.'
          : err instanceof Error
            ? err.message
            : 'Could not start recording. Please check your device settings.'
      setErrorMsg(msg)
      setState('error')
    }
  }

  const stopRecording = () => {
    // Stop the timer
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }

    // Stop audio capture
    if (pcmRecorderRef.current?.isRecording) {
      pcmRecorderRef.current.stopRecording()
    }
    pcmRecorderRef.current = null

    if (audioContextRef.current) {
      audioContextRef.current.close().catch(() => {})
      audioContextRef.current = null
    }

    setState('stopping')

    // Signal end-of-audio to Speechmatics
    if (clientRef.current) {
      clientRef.current.stopRecognition().catch(() => {
        // If stopRecognition fails, force end
        handleEndOfTranscript()
      })

      // Safety net: force-submit after 5 seconds if EndOfTranscript doesn't arrive
      safetyTimeoutRef.current = setTimeout(() => {
        handleEndOfTranscript()
        cleanup()
      }, 5000)
    } else {
      handleEndOfTranscript()
    }
  }

  const reset = () => {
    cleanup()
    setState('idle')
    setElapsed(0)
    setErrorMsg('')
    setPartialTranscript('')
    setFinalTranscript('')
    finalTranscriptRef.current = ''
    submittedRef.current = false
  }

  return (
    <div className="recorder-body">
      {state === 'idle' && (
        <button
          type="button"
          className="recorder-btn recorder-btn-start"
          onClick={startRecording}
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            width="22"
            height="22"
          >
            <rect x="9" y="1" width="6" height="11" rx="3" />
            <path d="M19 10v1a7 7 0 01-14 0v-1" />
            <line x1="12" y1="19" x2="12" y2="23" />
            <line x1="8" y1="23" x2="16" y2="23" />
          </svg>
          Record
        </button>
      )}

      {state === 'connecting' && (
        <div className="recorder-status">
          <span className="recorder-spinner" />
          <span>Connecting...</span>
        </div>
      )}

      {state === 'recording' && (
        <div className="recorder-active">
          <div className="recorder-indicator">
            <span className="recorder-pulse" />
            <span className="recorder-time">{formatTime(elapsed)}</span>
          </div>

          <div className="recorder-transcript">
            {finalTranscript || partialTranscript ? (
              <>
                {finalTranscript && (
                  <span className="recorder-transcript-final">
                    {finalTranscript}
                  </span>
                )}
                {partialTranscript && (
                  <span className="recorder-transcript-partial">
                    {partialTranscript}
                  </span>
                )}
              </>
            ) : (
              <span className="recorder-transcript-placeholder">
                Listening...
              </span>
            )}
          </div>

          <button
            type="button"
            className="recorder-btn recorder-btn-stop"
            onClick={stopRecording}
          >
            <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20">
              <rect x="6" y="6" width="12" height="12" rx="2" />
            </svg>
            Stop
          </button>
        </div>
      )}

      {state === 'stopping' && (
        <div className="recorder-status">
          <span className="recorder-spinner" />
          <span>Finishing...</span>
        </div>
      )}

      {state === 'uploading' && (
        <div className="recorder-status">
          <span className="recorder-spinner" />
          <span>Submitting transcript...</span>
        </div>
      )}

      {state === 'success' && (
        <div className="recorder-status recorder-status-success">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            width="20"
            height="20"
          >
            <path d="M20 6L9 17l-5-5" />
          </svg>
          <span>Transcript submitted successfully</span>
          {finalTranscript && (
            <div className="recorder-transcript-preview">{finalTranscript}</div>
          )}
          <button
            type="button"
            className="recorder-btn recorder-btn-again"
            onClick={reset}
          >
            Record Again
          </button>
        </div>
      )}

      {state === 'error' && (
        <div className="recorder-status recorder-status-error">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            width="20"
            height="20"
          >
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
          <span>{errorMsg}</span>
          <button
            type="button"
            className="recorder-btn recorder-btn-again"
            onClick={reset}
          >
            Try Again
          </button>
        </div>
      )}
    </div>
  )
}
