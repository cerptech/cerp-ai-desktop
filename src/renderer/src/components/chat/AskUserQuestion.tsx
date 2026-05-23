import { useState } from 'react'
import type { AskUserQuestionItem, UserAnswerPayload } from '../../../../preload/index'

interface AskUserQuestionProps {
  questions: AskUserQuestionItem[]
  onAnswer: (answers: UserAnswerPayload) => void
  /** True while the answers are being submitted (disables the button) */
  isSubmitting?: boolean
}

// ── Single question card ────────────────────────────────────────────────────

interface QuestionCardProps {
  item: AskUserQuestionItem
  answer: string | string[] | undefined
  onChange: (value: string | string[]) => void
  showOtherInput: boolean
  otherText: string
  onToggleOther: () => void
  onOtherTextChange: (text: string) => void
}

function QuestionCard({
  item,
  answer,
  onChange,
  showOtherInput,
  otherText,
  onToggleOther,
  onOtherTextChange,
}: QuestionCardProps) {
  function handleOptionClick(label: string) {
    if (item.multiSelect) {
      const current = Array.isArray(answer) ? answer : []
      const next = current.includes(label)
        ? current.filter((v) => v !== label)
        : [...current, label]
      onChange(next)
    } else {
      onChange(label)
    }
  }

  function isSelected(label: string): boolean {
    if (item.multiSelect) return Array.isArray(answer) && answer.includes(label)
    return answer === label
  }

  return (
    <div className="border border-slate-200 rounded-xl bg-white overflow-hidden shadow-sm">
      {/* Header chip */}
      <div className="flex items-center gap-2 px-4 pt-3 pb-2 border-b border-slate-100">
        <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wide bg-brand-orange/10 text-brand-orange">
          {item.header}
        </span>
        {item.multiSelect && (
          <span className="text-[10px] text-slate-400">(podés elegir varias)</span>
        )}
      </div>

      {/* Question text */}
      <p className="px-4 pt-3 pb-2 text-sm font-medium text-slate-700 leading-snug">
        {item.question}
      </p>

      {/* Options */}
      <div className="px-4 pb-3 flex flex-col gap-1.5">
        {item.options.map((opt) => {
          const selected = isSelected(opt.label)
          return (
            <button
              key={opt.label}
              onClick={() => handleOptionClick(opt.label)}
              className={[
                'w-full text-left rounded-lg border px-3 py-2.5 transition-all duration-150',
                'focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-orange/50',
                selected
                  ? 'border-brand-orange bg-brand-orange/5 shadow-sm'
                  : 'border-slate-200 hover:border-slate-300 hover:bg-slate-50',
              ].join(' ')}
            >
              <div className="flex items-start gap-2.5">
                {/* Radio / checkbox indicator */}
                <span
                  className={[
                    'mt-0.5 flex-shrink-0 rounded-full border-2 transition-colors',
                    item.multiSelect ? 'rounded-md w-4 h-4' : 'rounded-full w-4 h-4',
                    selected
                      ? 'border-brand-orange bg-brand-orange'
                      : 'border-slate-300 bg-white',
                  ].join(' ')}
                  aria-hidden="true"
                >
                  {selected && (
                    <svg
                      className="w-full h-full text-white p-[2px]"
                      fill="none"
                      viewBox="0 0 16 16"
                      stroke="currentColor"
                      strokeWidth={3}
                    >
                      {item.multiSelect ? (
                        <path strokeLinecap="round" strokeLinejoin="round" d="M3 8l3.5 3.5L13 4" />
                      ) : (
                        <circle cx="8" cy="8" r="3" fill="currentColor" stroke="none" />
                      )}
                    </svg>
                  )}
                </span>

                <div className="min-w-0">
                  <span
                    className={[
                      'block text-sm font-semibold leading-tight',
                      selected ? 'text-brand-orange' : 'text-slate-700',
                    ].join(' ')}
                  >
                    {opt.label}
                  </span>
                  {opt.description && (
                    <span className="block text-[11px] text-slate-400 mt-0.5 leading-snug">
                      {opt.description}
                    </span>
                  )}
                </div>
              </div>
            </button>
          )
        })}

        {/* "Otro..." option — always appended by the system */}
        <button
          onClick={onToggleOther}
          className={[
            'w-full text-left rounded-lg border px-3 py-2.5 transition-all duration-150',
            'focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-orange/50',
            showOtherInput
              ? 'border-brand-orange bg-brand-orange/5'
              : 'border-slate-200 hover:border-slate-300 hover:bg-slate-50',
          ].join(' ')}
        >
          <div className="flex items-center gap-2.5">
            <span
              className={[
                'flex-shrink-0 rounded-full border-2 w-4 h-4 transition-colors',
                showOtherInput ? 'border-brand-orange bg-brand-orange' : 'border-slate-300 bg-white',
              ].join(' ')}
              aria-hidden="true"
            />
            <span
              className={[
                'text-sm font-semibold',
                showOtherInput ? 'text-brand-orange' : 'text-slate-500',
              ].join(' ')}
            >
              Otro...
            </span>
          </div>
        </button>

        {/* Free-text input for "Otro..." */}
        {showOtherInput && (
          <textarea
            autoFocus
            value={otherText}
            onChange={(e) => onOtherTextChange(e.target.value)}
            placeholder="Escribe tu respuesta..."
            rows={2}
            className={[
              'w-full mt-1 rounded-lg border border-slate-200 bg-slate-50',
              'px-3 py-2 text-sm text-slate-700 placeholder-slate-400',
              'focus:outline-none focus:border-brand-orange focus:ring-1 focus:ring-brand-orange/30',
              'resize-none',
            ].join(' ')}
          />
        )}
      </div>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export function AskUserQuestion({ questions, onAnswer, isSubmitting }: AskUserQuestionProps) {
  // answers[question] = selected label | label[] (multiSelect) | undefined
  const [answers, setAnswers] = useState<Record<string, string | string[]>>({})
  // showOther[question] = true if "Otro..." is toggled for that question
  const [showOther, setShowOther] = useState<Record<string, boolean>>({})
  // otherText[question] = free text typed by user
  const [otherText, setOtherText] = useState<Record<string, string>>({})

  function handleChange(question: string, value: string | string[]) {
    setAnswers((prev) => ({ ...prev, [question]: value }))
    // Deselect "Otro" when an option is chosen (single-select only)
    if (!Array.isArray(value)) {
      setShowOther((prev) => ({ ...prev, [question]: false }))
    }
  }

  function handleToggleOther(question: string) {
    const next = !showOther[question]
    setShowOther((prev) => ({ ...prev, [question]: next }))
    if (next) {
      // Deselect previous single-select answer when Otro is opened
      setAnswers((prev) => {
        const current = prev[question]
        if (!Array.isArray(current)) {
          const { [question]: _, ...rest } = prev
          return rest
        }
        return prev
      })
    }
  }

  function handleOtherText(question: string, text: string) {
    setOtherText((prev) => ({ ...prev, [question]: text }))
  }

  function isQuestionAnswered(item: AskUserQuestionItem): boolean {
    const q = item.question
    if (showOther[q]) return (otherText[q] || '').trim().length > 0
    const a = answers[q]
    if (item.multiSelect) return Array.isArray(a) && a.length > 0
    return typeof a === 'string' && a.length > 0
  }

  const allAnswered = questions.every(isQuestionAnswered)

  function handleSubmit() {
    if (!allAnswered || isSubmitting) return

    const result: UserAnswerPayload = {}
    for (const item of questions) {
      const q = item.question
      if (showOther[q]) {
        result[q] = `Otro: ${(otherText[q] || '').trim()}`
      } else {
        result[q] = answers[q] ?? ''
      }
    }
    onAnswer(result)
  }

  // ── Step-by-step navigation ─────────────────────────────────────────────
  const [currentStep, setCurrentStep] = useState(0)
  const totalSteps = questions.length
  const isWizard = totalSteps > 1
  const currentItem = questions[currentStep]
  const isLastStep = currentStep === totalSteps - 1
  const currentAnswered = currentItem ? isQuestionAnswered(currentItem) : false

  function goNext() {
    if (!currentAnswered) return
    if (isLastStep) {
      handleSubmit()
    } else {
      setCurrentStep((s) => Math.min(s + 1, totalSteps - 1))
    }
  }

  function goBack() {
    setCurrentStep((s) => Math.max(s - 1, 0))
  }

  // Reset to step 0 if the questions prop changes (new turn)
  // (currentStep can stay valid in most cases, but guard against out-of-bounds)
  if (currentStep >= totalSteps) {
    // Defensive — should not happen because questions are immutable per turn
    setCurrentStep(0)
  }

  return (
    <div className="mt-3">
      {/* Progress indicator (wizard only) */}
      {isWizard && (
        <div className="flex items-center gap-2 mb-2 px-1">
          <span className="text-[11px] font-medium text-slate-500">
            Paso {currentStep + 1} de {totalSteps}
          </span>
          <div className="flex-1 h-1.5 rounded-full bg-slate-100 overflow-hidden">
            <div
              className="h-full bg-brand-orange transition-all duration-200"
              style={{ width: `${((currentStep + 1) / totalSteps) * 100}%` }}
            />
          </div>
          <span className="text-[11px] text-slate-400">
            {questions.filter(isQuestionAnswered).length} / {totalSteps} respondidas
          </span>
        </div>
      )}

      {/* Scrollable area for the current question */}
      <div className="max-h-[55vh] overflow-y-auto pr-1">
        {currentItem && (
          <QuestionCard
            key={currentItem.question}
            item={currentItem}
            answer={answers[currentItem.question]}
            onChange={(val) => handleChange(currentItem.question, val)}
            showOtherInput={!!showOther[currentItem.question]}
            otherText={otherText[currentItem.question] || ''}
            onToggleOther={() => handleToggleOther(currentItem.question)}
            onOtherTextChange={(text) => handleOtherText(currentItem.question, text)}
          />
        )}
      </div>

      {/* Navigation */}
      <div className="flex items-center justify-between pt-3">
        {isWizard ? (
          <button
            onClick={goBack}
            disabled={currentStep === 0 || isSubmitting}
            className={[
              'inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium',
              'transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-300',
              currentStep === 0 || isSubmitting
                ? 'text-slate-300 cursor-not-allowed'
                : 'text-slate-600 hover:bg-slate-100',
            ].join(' ')}
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
            </svg>
            Atrás
          </button>
        ) : (
          <span />
        )}

        <button
          onClick={goNext}
          disabled={!currentAnswered || isSubmitting}
          className={[
            'inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold',
            'transition-all duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-orange/50',
            currentAnswered && !isSubmitting
              ? 'bg-brand-orange text-white hover:bg-brand-orange/90 shadow-sm'
              : 'bg-slate-100 text-slate-400 cursor-not-allowed',
          ].join(' ')}
        >
          {isSubmitting ? (
            <>
              <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              Enviando...
            </>
          ) : isLastStep ? (
            <>
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
              Enviar respuestas
            </>
          ) : (
            <>
              Siguiente
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
              </svg>
            </>
          )}
        </button>
      </div>
    </div>
  )
}
