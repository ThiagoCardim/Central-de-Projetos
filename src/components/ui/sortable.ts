// Reordenação por arrastar (HTML5) com alça: o item só fica arrastável enquanto a
// alça está pressionada, para não atrapalhar campos de texto dentro da linha.
// Teclado: a alça aceita ↑/↓ para mover (acessível sem mouse).
import { useState, type DragEvent, type KeyboardEvent } from "react";

export function moveItem<T>(list: T[], from: number, to: number): T[] {
  const next = [...list];
  const [m] = next.splice(from, 1);
  next.splice(to, 0, m);
  return next;
}

export function useDragSort<T>(items: T[], onChange: (next: T[]) => void) {
  const [armed, setArmed] = useState<number | null>(null);
  const [dragging, setDragging] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);

  const reset = () => { setArmed(null); setDragging(null); setOver(null); };

  return {
    dragging,
    over,
    /** Props da linha (alvo e origem do arraste). */
    row: (i: number) => ({
      draggable: armed === i,
      onDragStart: (e: DragEvent) => {
        setDragging(i);
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", String(i));
      },
      onDragOver: (e: DragEvent) => { if (dragging === null) return; e.preventDefault(); if (over !== i) setOver(i); },
      onDrop: (e: DragEvent) => {
        e.preventDefault();
        if (dragging !== null && dragging !== i) onChange(moveItem(items, dragging, i));
        reset();
      },
      onDragEnd: reset,
    }),
    /** Props da alça. */
    grip: (i: number, label: string) => ({
      role: "button",
      tabIndex: 0,
      "aria-label": `${label}. Arraste ou use as setas para mover.`,
      title: "Arraste para reordenar",
      onPointerDown: () => setArmed(i),
      onPointerUp: () => setArmed(null),
      onKeyDown: (e: KeyboardEvent) => {
        if (e.key === "ArrowUp" && i > 0) { e.preventDefault(); onChange(moveItem(items, i, i - 1)); }
        if (e.key === "ArrowDown" && i < items.length - 1) { e.preventDefault(); onChange(moveItem(items, i, i + 1)); }
      },
    }),
  };
}

/** Grupos de execução: etapa "simultânea" fica no mesmo grupo da anterior. */
export function groupIndexes(parallelFlags: boolean[]): number[] {
  let g = 0;
  return parallelFlags.map((p, i) => { if (i > 0 && !p) g += 1; return g; });
}

/** Deduz quem é simultâneo à anterior a partir das dependências internas. */
export function parallelFromDeps(ids: string[], predsOf: (id: string) => string[]): boolean[] {
  return ids.map((id, i) => {
    if (i === 0) return false;
    const mine = predsOf(id).sort().join(",");
    const prev = predsOf(ids[i - 1]).sort().join(",");
    return !predsOf(id).includes(ids[i - 1]) && mine === prev;
  });
}
