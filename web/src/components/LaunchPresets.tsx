"use client";
import { plainLaunch } from "@/content/cometail";
import { LAUNCH_PRESETS, type LaunchPresetId } from "@/lib/launch-presets";

export function LaunchPresets({ value, onChange, disabled }: { value: LaunchPresetId; onChange: (id: LaunchPresetId) => void; disabled: boolean }) {
  const copy = plainLaunch.presets;
  return <fieldset className="launch-presets" disabled={disabled}>
    <legend>{copy.title}</legend>
    <p className="caption">{copy.body}</p>
    <div className="launch-preset-grid">
      {LAUNCH_PRESETS.map(preset => <label key={preset.id} className={`launch-preset ${value === preset.id ? "is-selected" : ""} ${!preset.config ? "is-unavailable" : ""}`}>
        <input type="radio" name="launch-preset" value={preset.id} checked={value === preset.id} disabled={!preset.config} onChange={() => onChange(preset.id)} />
        <span className="launch-preset-heading">{copy[preset.id].name}<span aria-hidden="true">{value === preset.id ? "●" : "○"}</span></span>
        <svg viewBox="0 0 120 60" aria-hidden="true"><path d="M4 4 V54 H116" className="preset-axis" /><path d={preset.curve} className="preset-path" /></svg>
        <span className="caption">{copy[preset.id].body}</span>
        <span className="launch-preset-unit">{preset.config ? `${copy.quote} ${preset.quote.symbol}` : copy.unavailable}</span>
      </label>)}
    </div>
    <p className="caption">{copy.shapeNote}</p>
  </fieldset>;
}
