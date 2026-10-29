import { useMemo, useReducer, useRef, useState, type RefObject } from "react";

export interface SlotPortalEntry<Block> {
  block: Block | null;
  container: HTMLDivElement;
  offset: number;
  placeholder: HTMLElement | null;
}

export interface SlotPortalHost<Block> {
  attach: (offset: number, placeholder: HTMLElement) => void;
  detach: (offset: number, placeholder: HTMLElement) => void;
  update: (offset: number, block: Block) => void;
}

export interface SlotPortalReconciliation<Block> {
  block: Block;
  changed: boolean;
}

export type ReconcileSlotPortalBlock<Block> = (
  previous: Block | null,
  next: Block,
) => SlotPortalReconciliation<Block>;

export interface SlotPortals<Block> {
  entries: readonly SlotPortalEntry<Block>[];
  host: SlotPortalHost<Block>;
  parkingRef: RefObject<HTMLDivElement | null>;
}

export function placeSlotPortalContainer(
  parent: HTMLElement,
  container: HTMLDivElement,
): void {
  if (container.parentNode === parent) {
    return;
  }
  if (
    container.isConnected &&
    parent.isConnected &&
    typeof parent.moveBefore === "function"
  ) {
    try {
      parent.moveBefore(container, null);
      return;
    } catch {
      parent.appendChild(container);
      return;
    }
  }
  parent.appendChild(container);
}

export function useSlotPortals<Block>(
  reconcile: ReconcileSlotPortalBlock<Block>,
): SlotPortals<Block> {
  const [entries] = useState(() => new Map<number, SlotPortalEntry<Block>>());
  const parkingRef = useRef<HTMLDivElement>(null);
  const [, rerender] = useReducer((revision: number) => revision + 1, 0);

  const host = useMemo(
    (): SlotPortalHost<Block> => ({
      attach(offset, placeholder) {
        let entry = entries.get(offset);
        if (entry === undefined) {
          entry = {
            block: null,
            container: document.createElement("div"),
            offset,
            placeholder,
          };
          entries.set(offset, entry);
        } else {
          entry.placeholder = placeholder;
        }
        placeSlotPortalContainer(placeholder, entry.container);
      },
      detach(offset, placeholder) {
        const entry = entries.get(offset);
        if (entry === undefined || entry.placeholder !== placeholder) {
          return;
        }
        entry.placeholder = null;
        if (parkingRef.current !== null) {
          placeSlotPortalContainer(parkingRef.current, entry.container);
        }
        queueMicrotask(() => {
          if (entry.placeholder !== null || entries.get(offset) !== entry) {
            return;
          }
          entry.container.remove();
          entries.delete(offset);
          rerender();
        });
      },
      update(offset, block) {
        const entry = entries.get(offset);
        if (entry === undefined) {
          return;
        }
        const reconciled = reconcile(entry.block, block);
        entry.block = reconciled.block;
        if (reconciled.changed) {
          rerender();
        }
      },
    }),
    [entries, reconcile],
  );

  const ordered = [...entries.values()].sort(
    (left, right) => left.offset - right.offset,
  );
  return { entries: ordered, host, parkingRef };
}
