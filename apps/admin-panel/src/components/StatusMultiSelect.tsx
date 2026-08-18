"use client";

import { useEffect, useRef, useState } from "react";
import { TODOS_STATUS } from "@/lib/periodo";

export function StatusMultiSelect({ selected, onChange }: { selected: string[]; onChange: (v: string[]) => void }) {
  const [aberto, setAberto] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onClickFora(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setAberto(false);
    }
    document.addEventListener("mousedown", onClickFora);
    return () => document.removeEventListener("mousedown", onClickFora);
  }, []);

  function toggle(status: string) {
    onChange(selected.includes(status) ? selected.filter((s) => s !== status) : [...selected, status]);
  }

  const label = selected.length === 0 ? "Todos os status" : `${selected.length} status selecionado(s)`;

  return (
    <div className="multiselect" ref={ref}>
      <button type="button" className="multiselect-btn" onClick={() => setAberto((v) => !v)}>
        {label} <span style={{ fontSize: 10 }}>▾</span>
      </button>
      {aberto && (
        <div className="multiselect-panel">
          {TODOS_STATUS.map((status) => (
            <label key={status}>
              <input type="checkbox" checked={selected.includes(status)} onChange={() => toggle(status)} />
              {status}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
