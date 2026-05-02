/**
 * Notes tab for the candidate detail page.
 * Uses Tiptap for rich-text editing with @mention support.
 * body_html stores Tiptap JSON as a serialized string. Rendered via generateHTML.
 */
import { useState, useEffect, useCallback } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Mention from "@tiptap/extension-mention";
import tippy from "tippy.js";
import "tippy.js/dist/tippy.css";
import type { SuggestionOptions } from "@tiptap/suggestion";
import { generateHTML } from "@tiptap/core";
import { Button } from "@/components/ui/button";
import { Loader2, Pencil, Trash2 } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { cn } from "@/lib/utils";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

type WorkspaceUser = { id: string; name: string | null; email: string };
type Note = {
  id: string;
  bodyHtml: string;
  bodyPlain: string;
  mentionedUserIds: string[];
  authorId: string;
  author: { id: string; name: string | null; email: string } | null;
  createdAt: string | null;
  updatedAt: string | null;
};

async function fetchNotes(candidateId: string): Promise<Note[]> {
  const r = await fetch(`${BASE}/api/candidates/${candidateId}/notes`);
  if (!r.ok) throw new Error("Failed to fetch notes");
  const data = await r.json() as { notes: Note[] };
  return data.notes;
}

async function fetchWorkspaceUsers(): Promise<WorkspaceUser[]> {
  const r = await fetch(`${BASE}/api/workspace/users`);
  if (!r.ok) return [];
  const data = await r.json() as { users: WorkspaceUser[] };
  return data.users;
}

async function saveNote(candidateId: string, bodyJson: object): Promise<Note> {
  const r = await fetch(`${BASE}/api/candidates/${candidateId}/notes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bodyJson }),
  });
  if (!r.ok) throw new Error("Failed to save note");
  return r.json();
}

async function deleteNote(noteId: string): Promise<void> {
  await fetch(`${BASE}/api/notes/${noteId}`, { method: "DELETE" });
}

// ── Tiptap node type for generateHTML ────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function renderNoteBody(bodyHtml: string): string {
  try {
    const doc = JSON.parse(bodyHtml) as object;
    return generateHTML(doc, [StarterKit, Mention.configure({ HTMLAttributes: { class: "mention" } })]);
  } catch {
    return `<p>${bodyHtml}</p>`;
  }
}

// ── Mention suggestion provider ───────────────────────────────────────────
function buildMentionSuggestion(users: WorkspaceUser[]): Partial<SuggestionOptions> {
  return {
    items({ query }: { query: string }) {
      return users
        .filter((u) => (u.name ?? u.email).toLowerCase().includes(query.toLowerCase()))
        .slice(0, 8);
    },
    render() {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let component: any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let popup: any;

      return {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        onStart(props: any) {
          component = document.createElement("ul");
          component.className =
            "bg-popover border rounded shadow-md py-1 text-sm z-50 min-w-40";
          document.body.appendChild(component);

          popup = tippy("body", {
            getReferenceClientRect: props.clientRect,
            appendTo: () => document.body,
            content: component,
            showOnCreate: true,
            interactive: true,
            trigger: "manual",
            placement: "bottom-start",
          });

          renderItems(props);
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        onUpdate(props: any) {
          renderItems(props);
          popup[0].setProps({ getReferenceClientRect: props.clientRect });
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        onKeyDown(props: any) {
          if (props.event.key === "Escape") {
            popup[0].hide();
            return true;
          }
          return false;
        },
        onExit() {
          popup[0].destroy();
          component.remove();
        },
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      function renderItems(props: any) {
        component.innerHTML = "";
        (props.items as WorkspaceUser[]).forEach((u) => {
          const li = document.createElement("li");
          li.className =
            "px-3 py-1.5 hover:bg-accent cursor-pointer rounded";
          li.textContent = u.name ?? u.email;
          li.addEventListener("click", () => props.command({ id: u.id, label: u.name ?? u.email }));
          component.appendChild(li);
        });
      }
    },
  };
}

// ── Note card ─────────────────────────────────────────────────────────────
function NoteCard({
  note,
  currentUserId,
  onDelete,
}: {
  note: Note;
  currentUserId: string | null;
  onDelete: (id: string) => void;
}) {
  const [deleting, setDeleting] = useState(false);

  return (
    <div className="border rounded-lg p-4 space-y-2 bg-card">
      <div className="flex items-start justify-between gap-2">
        <div className="text-sm font-medium">
          {note.author?.name ?? note.author?.email ?? "Unknown"}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-xs text-muted-foreground">
            {note.createdAt
              ? formatDistanceToNow(new Date(note.createdAt), { addSuffix: true })
              : ""}
          </span>
          {currentUserId === note.authorId && (
            <button
              className="text-muted-foreground hover:text-destructive"
              onClick={async () => {
                if (!confirm("Delete this note?")) return;
                setDeleting(true);
                await deleteNote(note.id);
                onDelete(note.id);
              }}
              disabled={deleting}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>
      <div
        className="prose prose-sm max-w-none text-foreground [&_.mention]:text-primary [&_.mention]:font-medium"
        dangerouslySetInnerHTML={{ __html: renderNoteBody(note.bodyHtml) }}
      />
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────
export function NotesTab({
  candidateId,
  currentUserId,
}: {
  candidateId: string;
  currentUserId: string | null;
}) {
  const [notes, setNotes] = useState<Note[]>([]);
  const [users, setUsers] = useState<WorkspaceUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);

  const load = useCallback(async () => {
    const [n, u] = await Promise.all([fetchNotes(candidateId), fetchWorkspaceUsers()]);
    setNotes(n);
    setUsers(u);
    setLoading(false);
  }, [candidateId]);

  useEffect(() => { void load(); }, [load]);

  const editor = useEditor({
    extensions: [
      StarterKit,
      Mention.configure({
        HTMLAttributes: { class: "mention" },
        suggestion: buildMentionSuggestion(users),
      }),
    ],
    editorProps: {
      attributes: {
        class: "prose prose-sm min-h-[80px] max-w-none px-3 py-2 focus:outline-none",
      },
    },
  });

  const handleSave = async () => {
    if (!editor || editor.isEmpty) return;
    setSaving(true);
    try {
      const note = await saveNote(candidateId, editor.getJSON());
      setNotes((prev) => [note, ...prev]);
      editor.commands.clearContent();
      setEditorOpen(false);
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <p className="text-muted-foreground py-4">Loading notes…</p>;

  return (
    <div className="space-y-4">
      {!editorOpen ? (
        <Button
          variant="outline"
          size="sm"
          onClick={() => setEditorOpen(true)}
          className="w-full justify-start text-muted-foreground"
        >
          <Pencil className="h-3.5 w-3.5 mr-2" />
          Add a note…
        </Button>
      ) : (
        <div className="border rounded-lg overflow-hidden bg-background">
          <EditorContent editor={editor} />
          <div className="flex justify-end gap-2 px-3 py-2 border-t bg-muted/30">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => { editor?.commands.clearContent(); setEditorOpen(false); }}
            >
              Cancel
            </Button>
            <Button size="sm" onClick={handleSave} disabled={saving}>
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : null}
              Save note
            </Button>
          </div>
        </div>
      )}

      {notes.length === 0 ? (
        <p className="text-center text-muted-foreground py-8 text-sm">No notes yet</p>
      ) : (
        <div className="space-y-3">
          {notes.map((n) => (
            <NoteCard
              key={n.id}
              note={n}
              currentUserId={currentUserId}
              onDelete={(id) => setNotes((prev) => prev.filter((x) => x.id !== id))}
            />
          ))}
        </div>
      )}
    </div>
  );
}
