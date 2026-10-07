"use client";
// The preset picker: Standard first and picked by default, every preset a simple card with one plain
// line. The curve shapes and config addresses live on /presets and in the form's Details.
import { plainLaunch, launchSimple } from "@/content/cometail";
import { LAUNCH_PRESETS, type LaunchPresetId } from "@/lib/launch-presets";

export function LaunchPresets({ value, onChange, disabled }: { value: LaunchPresetId; onChange: (id: LaunchPresetId) => void; disabled: boolean }) {
  const copy = plainLaunch.presets;
  return <fieldset className="launch-presets" disabled={disabled}>
    <legend>{launchSimple.presetTitle}</legend>
    <p className="caption">{launchSimple.presetBody}</p>
    <div className="launch-preset-grid">
      {LAUNCH_PRESETS.map(preset => <label key={preset.id} className={`launch-preset ${value === preset.id ? "is-selected" : ""} ${!preset.config ? "is-unavailable" : ""}`}>
        <input type="radio" name="launch-preset" value={preset.id} checked={value === preset.id} disabled={!preset.config} onChange={() => onChange(preset.id)} />
        <span className="launch-preset-check" aria-hidden="true" />
        <span className="launch-preset-text">
          <span className="launch-preset-heading">{copy[preset.id].name}</span>
          <span className="launch-preset-line">{launchSimple.lines[preset.id]}</span>
          {!preset.config && <span className="launch-preset-unit">{copy.unavailable}</span>}
        </span>
      </label>)}
    </div>
  </fieldset>;
}
