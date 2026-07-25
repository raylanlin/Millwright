// src/renderer/components/ChatInput.tsx
//
// P47: composer with an INLINE toolbar row (attach · Auto mode) inside the input box,
// and image attachments. Screenshots are how you actually point at a problem — "this
// fillet is on the wrong edge" is one picture and zero paragraphs — so the composer
// takes them by button, paste (Ctrl+V) or drag-and-drop.
//
// Approval mode moved out of Settings and onto this row: it is a per-task decision
// ("let it run unattended this time"), so it belongs where the task is typed.

import { forwardRef, useImperativeHandle, useRef, useState } from 'react';
import type { ThemeTokens } from '../themes';
import { useT } from '../i18n/LocaleContext';
import { ApprovalPicker, type ApprovalMode } from './ApprovalPicker';

export interface Attachment {
  /** data: URL — sent straight through as ChatMessage.images */
  dataUrl: string;
  name: string;
}

interface Props {
  t: ThemeTokens;
  value: string;
  onChange: (v: string) => void;
  /** P47: images travel with the message */
  onSend: (images?: string[]) => void;
  onCancel?: () => void;
  isGenerating: boolean;
  placeholder?: string;
  hint?: string;
  approvalMode?: ApprovalMode;
  onApprovalChange?: (m: ApprovalMode) => void;
}

export interface ChatInputHandle {
  focus: () => void;
}

const MAX_IMAGES = 4;

function readAsDataUrl(file: File): Promise<Attachment> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve({ dataUrl: String(fr.result), name: file.name || 'image.png' });
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(file);
  });
}

export const ChatInput = forwardRef<ChatInputHandle, Props>(function ChatInput(
  { t, value, onChange, onSend, onCancel, isGenerating, placeholder, hint, approvalMode, onApprovalChange },
  ref,
) {
  const ta = useRef<HTMLTextAreaElement>(null);
  const filePick = useRef<HTMLInputElement>(null);
  const tr = useT();
  const [shots, setShots] = useState<Attachment[]>([]);
  const [dragging, setDragging] = useState(false);
  useImperativeHandle(ref, () => ({ focus: () => ta.current?.focus() }), []);

  const canSend = (value.trim().length > 0 || shots.length > 0) && !isGenerating;

  const addFiles = async (files: FileList | File[] | null) => {
    if (!files) return;
    const imgs = Array.from(files).filter((f) => f.type.startsWith('image/'));
    if (!imgs.length) return;
    const read = await Promise.all(imgs.slice(0, MAX_IMAGES).map(readAsDataUrl));
    setShots((prev) => [...prev, ...read].slice(0, MAX_IMAGES));
  };

  const submit = () => {
    if (!canSend) return;
    onSend(shots.length ? shots.map((s) => s.dataUrl) : undefined);
    setShots([]);
  };

  const handleKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div style={{ padding: '14px 18px', borderTop: `1px solid ${t.sidebarBorder}`, flexShrink: 0 }}>
      <div
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => { e.preventDefault(); setDragging(false); void addFiles(e.dataTransfer?.files ?? null); }}
        style={{
          background: t.card,
          borderRadius: 12,
          border: `1px solid ${dragging ? t.btnPrimary : t.cardBorder}`,
          padding: '10px 10px 8px 14px',
        }}
      >
        {/* Attached screenshots */}
        {shots.length > 0 && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 9 }}>
            {shots.map((s, i) => (
              <div key={i} style={{ position: 'relative', width: 60, height: 60 }}>
                <img
                  src={s.dataUrl}
                  alt={s.name}
                  title={s.name}
                  style={{
                    width: '100%', height: '100%', objectFit: 'cover',
                    borderRadius: 7, border: `1px solid ${t.cardBorder}`, display: 'block',
                  }}
                />
                <button
                  onClick={() => setShots((prev) => prev.filter((_, j) => j !== i))}
                  title={tr('input.removeImage')}
                  style={{
                    position: 'absolute', top: -6, right: -6, width: 18, height: 18,
                    borderRadius: '50%', border: `1px solid ${t.cardBorder}`,
                    background: t.cardAlt, color: t.textSecondary, cursor: 'pointer',
                    fontSize: 10, lineHeight: 1, padding: 0, fontFamily: 'inherit',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
          <textarea
            ref={ta}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={handleKey}
            onPaste={(e) => {
              // P47: pasting a screenshot straight from the clipboard is the fast path
              const files = Array.from(e.clipboardData?.items ?? [])
                .filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
                .map((it) => it.getAsFile())
                .filter((f): f is File => !!f);
              if (files.length) { e.preventDefault(); void addFiles(files); }
            }}
            placeholder={placeholder ?? tr('input.placeholder')}
            rows={1}
            style={{
              flex: 1, background: 'none', border: 'none', color: t.text,
              fontSize: 13, outline: 'none', resize: 'none', padding: '2px 0 6px',
              lineHeight: 1.5, fontFamily: 'inherit', maxHeight: 140, minHeight: 22,
            }}
          />
          {isGenerating && onCancel ? (
            <button
              onClick={onCancel}
              title={tr('input.cancel')}
              style={{
                width: 32, height: 32, borderRadius: 8, border: `1px solid ${t.cardBorder}`,
                background: t.cardAlt, color: t.textSecondary, cursor: 'pointer', fontSize: 12,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                flexShrink: 0, fontFamily: 'inherit',
              }}
            >
              ⏹
            </button>
          ) : (
            <button
              onClick={submit}
              disabled={!canSend}
              title={tr('input.send')}
              style={{
                width: 32, height: 32, borderRadius: 8, border: 'none',
                background: canSend ? t.btnPrimary : t.cardAlt,
                color: canSend ? t.btnPrimaryText : t.textMuted,
                cursor: canSend ? 'pointer' : 'default', fontSize: 15,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                flexShrink: 0, fontFamily: 'inherit',
              }}
            >
              ↑
            </button>
          )}
        </div>

        {/* P47: inline toolbar — attach + approval mode, inside the box */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 4, marginLeft: -4 }}>
          <input
            ref={filePick}
            type="file"
            accept="image/*"
            multiple
            onChange={(e) => { void addFiles(e.target.files); e.target.value = ''; }}
            style={{ display: 'none' }}
          />
          <ToolbarButton t={t} title={tr('input.attachImage')} onClick={() => filePick.current?.click()}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="12" y1="5" x2="12" y2="19"></line>
              <line x1="5" y1="12" x2="19" y2="12"></line>
            </svg>
          </ToolbarButton>
          {onApprovalChange && (
            <ApprovalPicker
              mode={approvalMode ?? 'normal'}
              onChange={onApprovalChange}
              t={t}
              disabled={isGenerating}
            />
          )}
        </div>
      </div>
      {hint && (
        <div style={{ textAlign: 'center', marginTop: 6, fontSize: 10, color: t.textMuted }}>
          {hint}
        </div>
      )}
    </div>
  );
});

function ToolbarButton({
  t,
  title,
  onClick,
  children,
}: {
  t: ThemeTokens;
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      onClick={onClick}
      title={title}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        width: 28, height: 28, borderRadius: 7, border: 'none', cursor: 'pointer',
        background: hover ? t.cardAlt : 'transparent',
        color: t.textSecondary, padding: 0, fontFamily: 'inherit',
        display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
      }}
    >
      {children}
    </button>
  );
}
