import { ArrowUp, Check, ChevronDown, Sparkles, Square } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import type { ModelOption } from "../types";

type Props = {
  models: ModelOption[];
  model: string;
  onModelChange: (id: string) => void;
  onSend: (text: string) => void;
  onStop: () => void;
  streaming: boolean;
  placeholder: string;
  docked?: boolean;
  autoFocus?: boolean;
};

const MIN_HEIGHT = 66;
const MAX_HEIGHT = 200;

export function ChatBar({ models, model, onModelChange, onSend, onStop, streaming, placeholder, docked, autoFocus }: Props) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(Math.max(el.scrollHeight, MIN_HEIGHT), MAX_HEIGHT)}px`;
    el.style.overflowY = el.scrollHeight > MAX_HEIGHT ? "auto" : "hidden";
  }, [text]);

  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);

  const sentAt = useRef(0);

  const submit = () => {
    const value = text.trim();
    if (!value || streaming) return;
    sentAt.current = Date.now();
    onSend(value);
    setText("");
  };

  // The stop button appears where send was, so a double-click on send must not cancel the turn.
  const stop = () => {
    if (Date.now() - sentAt.current > 600) onStop();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className={`chatbar ${docked ? "chatbar--docked" : ""}`} onClick={() => ref.current?.focus()}>
      <textarea
        ref={ref}
        className="chatbar__input"
        aria-label="Message Errand Agent"
        placeholder={placeholder}
        value={text}
        rows={1}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <div className="chatbar__row" onClick={(e) => e.stopPropagation()}>
        <span className="chatbar__hint">Enter to send, Shift + Enter for a new line</span>
        <div className="chatbar__actions">
          <ModelPicker models={models} value={model} onChange={onModelChange} disabled={streaming} />
          {streaming ? (
            <button key="stop" type="button" className="send-btn" aria-label="Stop" onClick={stop}>
              <Square size={13} fill="currentColor" />
            </button>
          ) : (
            <button key="send" type="button" className="send-btn" aria-label="Send" onClick={submit} disabled={!text.trim()}>
              <ArrowUp size={16} strokeWidth={2.5} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function ModelPicker({
  models,
  value,
  onChange,
  disabled,
}: {
  models: ModelOption[];
  value: string;
  onChange: (id: string) => void;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const current = models.find((m) => m.id === value);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: globalThis.KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  return (
    <div className="model-picker" ref={wrap}>
      <button
        type="button"
        className="model-picker__button"
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled || models.length === 0}
        onClick={() => setOpen((o) => !o)}
      >
        <Sparkles size={15} className="model-picker__icon" />
        <span>{current?.label ?? "Model"}</span>
        <ChevronDown size={12} className="model-picker__chevron" />
      </button>
      {open && (
        <ul className="model-picker__menu" role="listbox" aria-label="Claude model">
          {models.map((m) => (
            <li key={m.id}>
              <button
                type="button"
                role="option"
                aria-selected={m.id === value}
                className="model-picker__option"
                onClick={() => {
                  onChange(m.id);
                  setOpen(false);
                }}
              >
                <span>
                  {m.label}
                  <small>{m.id}</small>
                </span>
                {m.id === value && <Check size={14} />}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
