import { useEffect, useRef, useState } from "react";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  DragOverlay,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  GripVertical,
  ArrowUp,
  ArrowDown,
  X,
  Film,
  Loader2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { api, errorMessage, type MediaItem } from "@/lib/api";
import { duration, queueOffsets } from "@/lib/format";
import { moveEntry } from "@/lib/rundown";
import { useStudio } from "@/lib/store";
type Entry = { uid: string; item: MediaItem };
function entries(items: MediaItem[]): Entry[] {
  const counts = new Map<number, number>();
  return items.map((item) => {
    const n = counts.get(item.id) ?? 0;
    counts.set(item.id, n + 1);
    return { uid: `${item.id}:${n}`, item };
  });
}
export default function Rundown({
  items,
  disabled,
}: {
  items: MediaItem[];
  disabled: boolean;
}) {
  const [order, setOrder] = useState(() => entries(items));
  const [dragged, setDragged] = useState<string | null>(null);
  const [saving, setSaving] = useState(false),
    [message, setMessage] = useState(""),
    [error, setError] = useState("");
  const pending = useRef(false);
  const refresh = useStudio((s) => s.refresh);
  useEffect(() => {
    if (!pending.current) setOrder(entries(items));
  }, [items]);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );
  async function save(next: Entry[], focusUid?: string) {
    if (disabled || pending.current) return;
    const previous = order;
    pending.current = true;
    setSaving(true);
    setError("");
    setMessage("");
    setOrder(next);
    try {
      await api("/api/queue", "PUT", { ids: next.map((e) => e.item.id) });
      await refresh();
      setMessage("Running order saved on this computer.");
    } catch (e) {
      setOrder(previous);
      setError(errorMessage(e));
    } finally {
      pending.current = false;
      setSaving(false);
      if (focusUid)
        requestAnimationFrame(() =>
          document.getElementById(`queue-handle-${focusUid}`)?.focus(),
        );
    }
  }
  function finish({ active, over }: DragEndEvent) {
    setDragged(null);
    if (!over || active.id === over.id) return;
    void save(
      moveEntry(
        order,
        order.findIndex((e) => e.uid === active.id),
        order.findIndex((e) => e.uid === over.id),
      ),
      String(active.id),
    );
  }
  const offsets = queueOffsets(order.map((e) => e.item));
  const selected = order.find((e) => e.uid === dragged);
  const locked = disabled || saving;
  return (
    <>
      <div className="rundown-tools">
        <span>
          {saving ? (
            <>
              <Loader2 size={14} className="animate-spin" /> Saving order…
            </>
          ) : (
            "Drag a handle to reorder. Keyboard: Space, arrow keys, then Space. Escape cancels."
          )}
        </span>
      </div>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={({ active }) => setDragged(String(active.id))}
        onDragCancel={() => setDragged(null)}
        onDragEnd={finish}
        accessibility={{
          announcements: {
            onDragStart({ active }) {
              return `Picked up ${order.find((e) => e.uid === active.id)?.item.title}.`;
            },
            onDragOver({ over }) {
              return over
                ? `Move to position ${order.findIndex((e) => e.uid === over.id) + 1} of ${order.length}.`
                : undefined;
            },
            onDragEnd() {
              return "Dropped. Saving running order.";
            },
            onDragCancel() {
              return "Reordering cancelled.";
            },
          },
        }}
      >
        <SortableContext
          items={order.map((e) => e.uid)}
          strategy={verticalListSortingStrategy}
        >
          <div className="rundown-header">
            <span>START</span>
            <span>PROGRAM</span>
            <span>DURATION</span>
            <span>ORDER</span>
          </div>
          <div
            role="list"
            aria-label="Playout running order"
            aria-busy={saving}
          >
            {order.map((entry, index) => (
              <SortableRow
                key={entry.uid}
                entry={entry}
                index={index}
                offset={offsets[index]}
                total={order.length}
                disabled={locked}
                onMove={(to) =>
                  void save(moveEntry(order, index, to), entry.uid)
                }
                onRemove={() =>
                  void save(order.filter((e) => e.uid !== entry.uid))
                }
              />
            ))}
          </div>
        </SortableContext>
        <DragOverlay>
          {selected ? (
            <div className="rundown-drag-overlay">
              <GripVertical size={18} />
              <strong>{selected.item.title}</strong>
              <span>{duration(selected.item.durationSeconds)}</span>
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
      <p
        className={error ? "form-error rundown-feedback" : "rundown-feedback"}
        role={error ? "alert" : "status"}
      >
        {error || message}
      </p>
    </>
  );
}
function SortableRow({
  entry,
  index,
  offset,
  total,
  disabled,
  onMove,
  onRemove,
}: {
  entry: Entry;
  index: number;
  offset: number;
  total: number;
  disabled: boolean;
  onMove: (to: number) => void;
  onRemove: () => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: entry.uid, disabled });
  const { item } = entry;
  return (
    <div
      role="listitem"
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.3 : 1,
      }}
      className="rundown-row sortable-row"
    >
      <span className="mono muted">{duration(offset)}</span>
      <div className="rundown-title">
        <Button
          ref={setActivatorNodeRef}
          id={`queue-handle-${entry.uid}`}
          className="drag-handle"
          variant="ghost"
          size="icon-sm"
          disabled={disabled}
          {...attributes}
          {...listeners}
          aria-label={`Reorder ${item.title}, position ${index + 1} of ${total}`}
        >
          <GripVertical size={17} />
        </Button>
        <span className="media-thumb">
          <Film size={19} />
        </span>
        <div>
          <strong>{item.title}</strong>
          <small>
            {item.width} × {item.height} ·{" "}
            {item.hasAudio ? "With audio" : "Silent"}
          </small>
        </div>
      </div>
      <span className="mono">{duration(item.durationSeconds)}</span>
      <div className="row-actions">
        <Button
          size="icon-sm"
          variant="ghost"
          disabled={disabled || index === 0}
          aria-label={`Move ${item.title} up`}
          onClick={() => onMove(index - 1)}
        >
          <ArrowUp size={15} />
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          disabled={disabled || index === total - 1}
          aria-label={`Move ${item.title} down`}
          onClick={() => onMove(index + 1)}
        >
          <ArrowDown size={15} />
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          disabled={disabled}
          aria-label={`Remove ${item.title} from queue`}
          onClick={onRemove}
        >
          <X size={15} />
        </Button>
      </div>
    </div>
  );
}
