"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// Correctable deduced metadata (task 10). Values are deduced from photos by
// Claude; this lets you fix any that are off. Saves via PATCH .../metadata.
export interface MetadataValues {
  hasEaves: number | null;
  masterBedSqm: number | null;
  avgOtherBedSqm: number | null;
  commonAreasCount: number | null;
  balconySqm: number | null;
  backGardenSqm: number | null;
  pergolaCovered: number | null;
  hasLawn: number | null;
  lawnType: string | null;
  floodOverlay: number | null;
  bushfireOverlay: number | null;
  altitudeM: number | null;
}

const NUM_FIELDS: { key: keyof MetadataValues; label: string }[] = [
  { key: "masterBedSqm", label: "Master bedroom (m²)" },
  { key: "avgOtherBedSqm", label: "Other bedrooms avg (m²)" },
  { key: "commonAreasCount", label: "Common areas (count)" },
  { key: "balconySqm", label: "Balcony (m²)" },
  { key: "backGardenSqm", label: "Back garden (m²)" },
  { key: "altitudeM", label: "Altitude (m)" },
];
const BOOL_FIELDS: { key: keyof MetadataValues; label: string }[] = [
  { key: "hasEaves", label: "All-around eaves" },
  { key: "pergolaCovered", label: "Covered pergola/deck" },
  { key: "hasLawn", label: "Has lawn" },
  { key: "floodOverlay", label: "Flood overlay" },
  { key: "bushfireOverlay", label: "Bushfire overlay" },
];

export default function MetadataEditor({
  propertyId,
  initial,
}: {
  propertyId: string;
  initial: MetadataValues;
}) {
  const router = useRouter();
  const [v, setV] = useState<MetadataValues>(initial);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const num = (key: keyof MetadataValues) =>
    (val: string) =>
      setV((s) => ({ ...s, [key]: val === "" ? null : Number(val) }));
  const bool = (key: keyof MetadataValues) =>
    (val: string) =>
      setV((s) => ({ ...s, [key]: val === "" ? null : Number(val) }));

  async function save() {
    setSaving(true);
    setSaved(false);
    await fetch(`/api/properties/${propertyId}/metadata`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      // Send everything; state mirrors current values, so untouched fields
      // re-write themselves. null → "" so the API's coerce() clears to NULL.
      body: JSON.stringify(
        Object.fromEntries(Object.entries(v).map(([k, val]) => [k, val ?? ""])),
      ),
    });
    setSaving(false);
    setSaved(true);
    router.refresh();
  }

  return (
    <details className="rounded-lg border border-neutral-200 p-4 text-sm dark:border-neutral-800">
      <summary className="cursor-pointer font-semibold">
        Edit deduced metadata
        <span className="ml-2 font-normal text-neutral-400">
          (eaves, room sizes, lawn — correct anything that&apos;s off)
        </span>
      </summary>
      <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3">
        {BOOL_FIELDS.map((f) => (
          <label key={f.key} className="flex flex-col gap-1">
            <span className="text-neutral-400">{f.label}</span>
            <select
              value={v[f.key] == null ? "" : String(v[f.key])}
              onChange={(e) => bool(f.key)(e.target.value)}
              className="rounded border border-neutral-300 bg-transparent px-2 py-1 dark:border-neutral-700"
            >
              <option value="">Unknown</option>
              <option value="1">Yes</option>
              <option value="0">No</option>
            </select>
          </label>
        ))}
        <label className="flex flex-col gap-1">
          <span className="text-neutral-400">Lawn type</span>
          <select
            value={v.lawnType ?? ""}
            onChange={(e) =>
              setV((s) => ({ ...s, lawnType: e.target.value || null }))
            }
            className="rounded border border-neutral-300 bg-transparent px-2 py-1 dark:border-neutral-700"
          >
            <option value="">—</option>
            <option value="real">Real</option>
            <option value="fake">Fake</option>
          </select>
        </label>
        {NUM_FIELDS.map((f) => (
          <label key={f.key} className="flex flex-col gap-1">
            <span className="text-neutral-400">{f.label}</span>
            <input
              type="number"
              value={v[f.key] == null ? "" : String(v[f.key])}
              onChange={(e) => num(f.key)(e.target.value)}
              className="rounded border border-neutral-300 bg-transparent px-2 py-1 dark:border-neutral-700"
            />
          </label>
        ))}
      </div>
      <div className="mt-4 flex items-center gap-3">
        <button
          onClick={save}
          disabled={saving}
          className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save"}
        </button>
        {saved && !saving && (
          <span className="text-xs text-green-600">Saved ✓</span>
        )}
      </div>
    </details>
  );
}
