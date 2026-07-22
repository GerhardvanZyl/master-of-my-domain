"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Checkbox dropdown for picking any number of options (e.g. suburbs). Empty
 * selection = "no filter". Closes on outside-click / Escape.
 */
export default function MultiSelect({
  options,
  value,
  onChange,
  placeholder = "any",
  width = "sm:w-44",
}: {
  options: string[];
  value: string[];
  onChange: (v: string[]) => void;
  placeholder?: string;
  width?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const toggle = (o: string) =>
    onChange(value.includes(o) ? value.filter((x) => x !== o) : [...value, o]);

  const label =
    value.length === 0
      ? placeholder
      : value.length === 1
        ? value[0]
        : `${value.length} selected`;

  return (
    <div ref={ref} className={`relative min-w-0 flex-1 sm:flex-none ${width}`}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={`field flex w-full items-center justify-between gap-2 ${width}`}
      >
        <span className={`truncate ${value.length ? "" : "text-soft"}`}>{label}</span>
        <span className="shrink-0 text-mute">▾</span>
      </button>
      {open && (
        <div className="absolute left-0 z-30 mt-1 max-h-72 w-56 overflow-y-auto rounded-xl border border-line bg-white p-1 shadow-lg">
          {value.length > 0 && (
            <button
              type="button"
              onClick={() => onChange([])}
              className="mb-1 block w-full rounded px-2 py-1 text-left text-xs text-mute hover:bg-paper"
            >
              Clear ({value.length})
            </button>
          )}
          {options.map((o) => (
            <label
              key={o}
              className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-paper"
            >
              <input
                type="checkbox"
                checked={value.includes(o)}
                onChange={() => toggle(o)}
                className="accent-[#1F4A3A]"
              />
              <span className="truncate">{o}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
