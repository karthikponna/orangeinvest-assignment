import { AlertTriangle, Check, KeyRound, Menu, RotateCcw, Store, X } from "lucide-react";
import { useEffect, useRef } from "react";
import type { Fixtures, Health } from "../types";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  health: Health | null;
  fixtures: Fixtures | null;
  onNewChat: () => void;
};

export function SettingsMenu({ open, onOpenChange, health, fixtures, onNewChat }: Props) {
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!panel.current?.contains(e.target as Node)) onOpenChange(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onOpenChange(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open, onOpenChange]);

  const missingKey = health !== null && !health.has_api_key;

  return (
    <div className="menu" ref={panel}>
      <button
        type="button"
        className="glass menu__button"
        aria-label={open ? "Close menu" : "Open menu"}
        aria-expanded={open}
        onClick={() => onOpenChange(!open)}
      >
        {open ? <X size={20} /> : <Menu size={20} />}
        {missingKey && !open && <span className="menu__dot" aria-hidden />}
      </button>

      {open && (
        <div className="glass menu__panel" role="dialog" aria-label="Settings">
          <div className="menu__brand">errand agent</div>

          <section className="menu__section">
            <div className="menu__label">
              <KeyRound size={14} /> Claude API key
            </div>
            {health === null ? (
              <p className="menu__fine">Checking the server… (start it with bun run dev)</p>
            ) : health.has_api_key ? (
              <div className="key-saved">
                <span className="key-saved__value">
                  <Check size={14} /> configured on the server
                </span>
              </div>
            ) : (
              <p className="menu__hint">
                <AlertTriangle size={13} /> Add ANTHROPIC_API_KEY to the .env file at the repo root and restart the server.
              </p>
            )}
            {health && (
              <p className="menu__fine">
                Agent model <code>{health.default_model}</code>, intent gate <code>{health.intent_model}</code>, user <code>{health.user_id}</code>.
              </p>
            )}
          </section>

          <section className="menu__section">
            <div className="menu__label">
              <Store size={14} /> Mock providers
            </div>
            <p className="menu__fine">Bengaluru areas: {fixtures?.areas.join(", ")}</p>
            <ul className="providers">
              {fixtures?.providers.map((p) => (
                <li key={p.id}>
                  <div className="providers__top">
                    <span className="copy">{p.id}</span>
                    <span className="providers__name">{p.name}</span>
                    <span className="providers__rating">★ {p.rating}</span>
                  </div>
                  <div className="providers__meta">
                    {Object.entries(p.services)
                      .map(([s, price]) => `${s.replace(/_/g, " ")} ₹${price}`)
                      .join(" · ")}
                  </div>
                  <div className="providers__tags">
                    {p.price_change_on_hold ? <span className="tag tag--warn">+{Math.round(p.price_change_on_hold * 100)}% on hold</span> : null}
                    {p.has_injection_review ? <span className="tag tag--danger">injection review</span> : null}
                  </div>
                </li>
              ))}
            </ul>
          </section>

          <button
            type="button"
            className="menu__new"
            onClick={() => {
              onNewChat();
              onOpenChange(false);
            }}
          >
            <RotateCcw size={14} /> New conversation
          </button>
        </div>
      )}
    </div>
  );
}
