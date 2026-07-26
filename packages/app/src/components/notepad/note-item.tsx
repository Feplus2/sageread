import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import type { Note } from "@/types/note";
import { ask } from "@tauri-apps/plugin-dialog";
import dayjs from "dayjs";
import { useCallback, useState } from "react";
import { useNotepad } from "./hooks";
import { NoteDetailDialog } from "./note-detail-dialog";

interface NoteItemProps {
  note: Note;
}

export const NoteItem = ({ note }: NoteItemProps) => {
  const { handleDeleteNote } = useNotepad();
  const [showDetail, setShowDetail] = useState(false);

  const handleNativeDelete = useCallback(async () => {
    try {
      const preview = note.content || "";
      const confirmed = await ask(
        `确定要删除这条笔记吗？\n\n"${preview.length > 50 ? `${preview.substring(0, 50)}...` : preview}"\n\n此操作无法撤销。`,
        {
          title: "确认删除",
          kind: "warning",
        },
      );

      if (confirmed) {
        await handleDeleteNote(note.id);
      }
    } catch (error) {
      console.error("删除笔记失败:", error);
    }
  }, [note, handleDeleteNote]);

  const handleClick = useCallback(() => {
    setShowDetail(true);
  }, []);

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div className="group cursor-pointer rounded-lg bg-muted p-2" onClick={handleClick}>
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <p className="line-clamp-3 select-auto text-neutral-700 text-sm dark:text-neutral-200">
                  {note.content || "暂无内容"}
                </p>

                <div className="mt-1 text-neutral-800 text-xs dark:text-neutral-500">
                  {dayjs(note.createdAt).format("YYYY-MM-DD HH:mm:ss")}
                </div>
              </div>
            </div>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem variant="destructive" onClick={() => handleNativeDelete()}>
            删除
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      <NoteDetailDialog note={note} open={showDetail} onOpenChange={setShowDetail} />
    </>
  );
};
