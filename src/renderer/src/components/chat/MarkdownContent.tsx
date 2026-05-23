import { useState, type ComponentPropsWithoutRef } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

// ---------------------------------------------------------------------------
// CodeBlock — renders a fenced code block with language label + copy button
// ---------------------------------------------------------------------------

interface CodeBlockProps {
  language: string
  children: string
}

function CodeBlock({ language, children }: CodeBlockProps) {
  const [copied, setCopied] = useState(false)

  function handleCopy() {
    navigator.clipboard.writeText(children).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  return (
    <div className="relative my-3 rounded-lg overflow-hidden border border-slate-700">
      {/* Header bar: language label + copy button */}
      <div className="flex items-center justify-between bg-slate-800 px-3 py-1.5">
        {language ? (
          <span className="text-[10px] font-mono text-slate-400 select-none">{language}</span>
        ) : (
          <span />
        )}
        <button
          onClick={handleCopy}
          aria-label="Copiar código"
          className="text-[10px] text-slate-400 hover:text-slate-200 transition-colors flex items-center gap-1"
        >
          {copied ? (
            <>
              <svg className="w-3 h-3 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
              <span className="text-emerald-400">Copiado</span>
            </>
          ) : (
            <>
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
              <span>Copiar</span>
            </>
          )}
        </button>
      </div>

      {/* Code content */}
      <pre className="bg-slate-900 text-slate-200 px-4 py-3 text-xs font-mono overflow-x-auto leading-relaxed m-0">
        <code>{children}</code>
      </pre>
    </div>
  )
}

// ---------------------------------------------------------------------------
// InlineCode — renders backtick inline code
// ---------------------------------------------------------------------------

function InlineCode({ children }: { children: React.ReactNode }) {
  return (
    <code className="bg-slate-100 text-brand-orange px-1.5 py-0.5 rounded text-xs font-mono">
      {children}
    </code>
  )
}

// ---------------------------------------------------------------------------
// Code renderer — react-markdown passes className="language-xxx" on block code
// The `code` element is rendered inside a `pre` by react-markdown for blocks,
// so we detect blocks by the presence of "language-" in className.
// ---------------------------------------------------------------------------

type CodeProps = ComponentPropsWithoutRef<'code'> & { node?: unknown }

function CodeRenderer({ className, children }: CodeProps) {
  const match = /language-(\w+)/.exec(className ?? '')

  if (match) {
    // Block code — className present means it came from a fenced code block
    const rawText = String(children).replace(/\n$/, '')
    return <CodeBlock language={match[1]} children={rawText} />
  }

  // Inline code
  return <InlineCode>{children}</InlineCode>
}

// ---------------------------------------------------------------------------
// MarkdownContent — public component
// ---------------------------------------------------------------------------

interface MarkdownContentProps {
  content: string
}

export function MarkdownContent({ content }: MarkdownContentProps) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        // Headings
        h1: ({ children }) => <h1 className="text-lg font-bold text-slate-900 mt-4 mb-2 first:mt-0">{children}</h1>,
        h2: ({ children }) => <h2 className="text-base font-bold text-slate-800 mt-3 mb-1.5 first:mt-0">{children}</h2>,
        h3: ({ children }) => <h3 className="text-sm font-semibold text-slate-800 mt-2 mb-1 first:mt-0">{children}</h3>,

        // Paragraphs
        p: ({ children }) => <p className="text-sm leading-relaxed mb-2 last:mb-0">{children}</p>,

        // Lists
        ul: ({ children }) => <ul className="list-disc list-inside text-sm space-y-0.5 mb-2 ml-1">{children}</ul>,
        ol: ({ children }) => <ol className="list-decimal list-inside text-sm space-y-0.5 mb-2 ml-1">{children}</ol>,
        li: ({ children }) => <li className="text-sm leading-relaxed">{children}</li>,

        // Code — our custom renderer handles both inline and block
        code: CodeRenderer,

        // react-markdown wraps block code in <pre><code>. We handle everything
        // inside CodeRenderer, so <pre> just renders its children transparently.
        pre: ({ children }) => <>{children}</>,

        // Tables
        table: ({ children }) => (
          <div className="overflow-x-auto my-3">
            <table className="min-w-full text-xs border border-slate-200 rounded-lg overflow-hidden">
              {children}
            </table>
          </div>
        ),
        thead: ({ children }) => <thead className="bg-slate-50">{children}</thead>,
        tbody: ({ children }) => <tbody className="divide-y divide-slate-100">{children}</tbody>,
        tr: ({ children }) => <tr className="hover:bg-slate-50/50">{children}</tr>,
        th: ({ children }) => (
          <th className="px-3 py-1.5 text-left font-medium text-slate-700 border-b border-slate-200 whitespace-nowrap">
            {children}
          </th>
        ),
        td: ({ children }) => <td className="px-3 py-1.5 text-slate-600">{children}</td>,

        // Links
        a: ({ href, children }) => (
          <a href={href} target="_blank" rel="noopener noreferrer" className="text-brand-orange hover:underline">
            {children}
          </a>
        ),

        // Blockquote
        blockquote: ({ children }) => (
          <blockquote className="border-l-2 border-brand-orange/40 pl-3 my-2 text-slate-500 italic bg-slate-50/50 py-1 rounded-r">
            {children}
          </blockquote>
        ),

        // Horizontal rule
        hr: () => <hr className="my-3 border-slate-200" />,

        // Bold/Strong
        strong: ({ children }) => <strong className="font-semibold text-slate-900">{children}</strong>,

        // Emphasis
        em: ({ children }) => <em className="italic text-slate-600">{children}</em>,
      }}
    >
      {content}
    </ReactMarkdown>
  )
}
