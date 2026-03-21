import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

interface MarkdownContentProps {
  content: string
}

export function MarkdownContent({ content }: MarkdownContentProps) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        // Headings
        h1: ({ children }) => <h1 className="text-lg font-bold text-slate-900 mt-4 mb-2">{children}</h1>,
        h2: ({ children }) => <h2 className="text-base font-bold text-slate-800 mt-3 mb-1.5">{children}</h2>,
        h3: ({ children }) => <h3 className="text-sm font-semibold text-slate-800 mt-2 mb-1">{children}</h3>,

        // Paragraphs
        p: ({ children }) => <p className="text-sm leading-relaxed mb-2 last:mb-0">{children}</p>,

        // Lists
        ul: ({ children }) => <ul className="list-disc list-inside text-sm space-y-0.5 mb-2 ml-1">{children}</ul>,
        ol: ({ children }) => <ol className="list-decimal list-inside text-sm space-y-0.5 mb-2 ml-1">{children}</ol>,
        li: ({ children }) => <li className="text-sm leading-relaxed">{children}</li>,

        // Code
        code: ({ className, children }) => {
          const isBlock = className?.includes('language-')
          if (isBlock) {
            return (
              <pre className="bg-slate-900 text-slate-200 rounded-lg p-3 my-2 text-xs font-mono overflow-x-auto leading-relaxed">
                <code>{children}</code>
              </pre>
            )
          }
          return (
            <code className="bg-slate-100 text-brand-orange px-1.5 py-0.5 rounded text-xs font-mono">
              {children}
            </code>
          )
        },
        pre: ({ children }) => <>{children}</>,

        // Tables
        table: ({ children }) => (
          <div className="overflow-x-auto my-2">
            <table className="min-w-full text-xs border border-slate-200 rounded-lg overflow-hidden">{children}</table>
          </div>
        ),
        thead: ({ children }) => <thead className="bg-slate-50">{children}</thead>,
        tbody: ({ children }) => <tbody className="divide-y divide-slate-100">{children}</tbody>,
        tr: ({ children }) => <tr className="hover:bg-slate-50/50">{children}</tr>,
        th: ({ children }) => <th className="px-3 py-1.5 text-left font-semibold text-slate-700 border-b border-slate-200">{children}</th>,
        td: ({ children }) => <td className="px-3 py-1.5 text-slate-600">{children}</td>,

        // Links
        a: ({ href, children }) => (
          <a href={href} target="_blank" rel="noopener noreferrer" className="text-brand-orange hover:underline">
            {children}
          </a>
        ),

        // Blockquote
        blockquote: ({ children }) => (
          <blockquote className="border-l-3 border-brand-orange/30 pl-3 my-2 text-slate-500 italic">
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
