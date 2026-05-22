"use client";

/**
 * Inline preview for binary content served via either `/api/files/...`
 * (tool-side: read_file image/PDF, screenshots) or `/api/attachments/...`
 * (user-uploaded files). Used by both `ToolBlock` (renders the bytes
 * inside the tool-result block so the human reviewer sees what the
 * agent saw) and `MessageBubble` (renders user-uploaded PDFs inline).
 *
 * The two routes are distinct (different trust models, different
 * cleanup) but the rendering shape is the same — image → `<img>`,
 * PDF → `<object>` with the browser's native viewer. Non-supported
 * media types just return null; the caller can fall back to a chip.
 */
export function MediaPreview({
  url,
  mediaType,
}: {
  url: string;
  mediaType: string;
}) {
  if (mediaType.startsWith("image/")) {
    return (
      <div className="px-3 py-2">
        <a href={url} target="_blank" rel="noreferrer" className="block">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={url}
            alt="media"
            className="max-h-96 max-w-full rounded border border-paper-rule"
          />
        </a>
      </div>
    );
  }
  if (mediaType === "application/pdf") {
    return (
      <div className="px-3 py-2 space-y-2">
        <object
          data={url}
          type="application/pdf"
          className="h-[28rem] w-full rounded border border-paper-rule bg-paper-sunk"
        >
          <div className="p-4 text-[12px] text-ink-soft">
            Inline PDF preview unavailable in this browser.{" "}
            <a
              href={url}
              target="_blank"
              rel="noreferrer"
              className="text-signal-blue underline"
            >
              Open in new tab
            </a>
            .
          </div>
        </object>
        <div className="text-[11px] text-ink-faint">
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="hover:text-signal-blue hover:underline"
          >
            Open PDF in new tab ↗
          </a>
        </div>
      </div>
    );
  }
  return null;
}
