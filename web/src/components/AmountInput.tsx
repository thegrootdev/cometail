"use client";
// One clean amount input: the unit sits inside the field, the wallet's balance sits above it, and
// quick amounts sit beneath it as sticker chips. Pure presentation: the page owns the value, the
// balance and what each quick amount means.
import { useId } from "react";
import { amounts as copy } from "@/content/cometail";

export type QuickAmount = { label: string; value: string | null };

export function AmountInput({
  label,
  unit,
  value,
  onChange,
  balance,
  quick,
  hint,
  error,
  disabled = false,
}: {
  label: string;
  unit: string;
  value: string;
  onChange: (next: string) => void;
  /** Formatted balance text, null while unknown, undefined to show none. */
  balance?: string | null;
  quick?: QuickAmount[];
  hint?: string;
  error?: string | null;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="amount-block">
      <div className="amount-head">
        <label htmlFor={`${id}-input`}>{label}</label>
        {balance !== undefined && (
          <span className="balance-line" aria-live="polite">
            {copy.balance} <strong>{balance ?? copy.balanceUnknown}</strong>
          </span>
        )}
      </div>
      <div className={`amount-field${error ? " is-invalid" : ""}`}>
        <input
          id={`${id}-input`}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          inputMode="decimal"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          placeholder="0.00"
          disabled={disabled}
          aria-invalid={!!error}
          aria-describedby={error ? `${id}-error` : hint ? `${id}-hint` : undefined}
        />
        <span className="amount-unit" aria-hidden="true">{unit}</span>
      </div>
      {quick && quick.length > 0 && (
        <div className="quick-amounts" role="group" aria-label={copy.quick}>
          {quick.map((q) => (
            <button
              type="button"
              key={q.label}
              className="quick-amount"
              disabled={disabled || q.value === null}
              aria-pressed={q.value !== null && q.value === value}
              onClick={() => q.value !== null && onChange(q.value)}
            >
              {q.label}
            </button>
          ))}
        </div>
      )}
      {error ? (
        <small id={`${id}-error`} className="field-error" role="status">{error}</small>
      ) : hint ? (
        <small id={`${id}-hint`} className="caption amount-hint">{hint}</small>
      ) : null}
    </div>
  );
}
