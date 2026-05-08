"use client";

import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

const components: Components = {
  p: (props) => <p className="mb-3 last:mb-0 leading-relaxed" {...props} />,
  h1: (props) => (
    <h1 className="mt-4 mb-2 text-xl font-semibold" {...props} />
  ),
  h2: (props) => (
    <h2 className="mt-4 mb-2 text-lg font-semibold" {...props} />
  ),
  h3: (props) => (
    <h3 className="mt-3 mb-2 text-base font-semibold" {...props} />
  ),
  ul: (props) => (
    <ul className="mb-3 ml-5 list-disc space-y-1 last:mb-0" {...props} />
  ),
  ol: (props) => (
    <ol className="mb-3 ml-5 list-decimal space-y-1 last:mb-0" {...props} />
  ),
  li: (props) => <li className="leading-relaxed" {...props} />,
  a: (props) => (
    <a
      className="text-sky-600 underline underline-offset-2 hover:text-sky-500"
      target="_blank"
      rel="noreferrer noopener"
      {...props}
    />
  ),
  blockquote: (props) => (
    <blockquote
      className="my-3 border-l-2 border-zinc-300 pl-3 text-zinc-600 dark:border-zinc-600 dark:text-zinc-400"
      {...props}
    />
  ),
  hr: () => <hr className="my-4 border-zinc-200 dark:border-zinc-700" />,
  table: (props) => (
    <div className="my-3 overflow-x-auto">
      <table className="w-full border-collapse text-sm" {...props} />
    </div>
  ),
  th: (props) => (
    <th
      className="border border-zinc-300 bg-zinc-100 px-2 py-1 text-left font-medium dark:border-zinc-700 dark:bg-zinc-800"
      {...props}
    />
  ),
  td: (props) => (
    <td
      className="border border-zinc-300 px-2 py-1 dark:border-zinc-700"
      {...props}
    />
  ),
  code: ({ className, children, ...rest }) => {
    const isBlock = /language-/.test(className ?? "");
    if (isBlock) {
      return (
        <code className={`${className ?? ""} font-mono text-[0.85em]`} {...rest}>
          {children}
        </code>
      );
    }
    return (
      <code
        className="rounded bg-zinc-200/70 px-1 py-0.5 font-mono text-[0.85em] dark:bg-zinc-700/70"
        {...rest}
      >
        {children}
      </code>
    );
  },
  pre: (props) => (
    <pre
      className="my-3 overflow-x-auto rounded-md bg-zinc-900 p-3 text-zinc-100 text-[0.85em] leading-relaxed"
      {...props}
    />
  ),
};

export function Markdown({ children }: { children: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
      {children}
    </ReactMarkdown>
  );
}
