import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { type Tag, getTags } from "@/services/tag-service";
import { useEffect, useState } from "react";

interface BatchTagDialogProps {
  isOpen: boolean;
  onClose: () => void;
  /** add=批量添加标签，remove=批量移除标签 */
  mode: "add" | "remove";
  bookCount: number;
  onApply: (tagIds: string[]) => Promise<void>;
}

export default function BatchTagDialog({ isOpen, onClose, mode, bookCount, onApply }: BatchTagDialogProps) {
  const [tags, setTags] = useState<Tag[]>([]);
  const [selectedTagIds, setSelectedTagIds] = useState<Set<string>>(new Set());
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setSelectedTagIds(new Set());
      getTags()
        .then(setTags)
        .catch((e) => console.error("加载标签失败:", e));
    }
  }, [isOpen]);

  const toggleTag = (tagId: string) => {
    setSelectedTagIds((prev) => {
      const next = new Set(prev);
      if (next.has(tagId)) {
        next.delete(tagId);
      } else {
        next.add(tagId);
      }
      return next;
    });
  };

  const handleConfirm = async () => {
    if (selectedTagIds.size === 0) return;
    setIsLoading(true);
    try {
      await onApply(Array.from(selectedTagIds));
      onClose();
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[80vh] sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{mode === "add" ? "批量添加标签" : "批量移除标签"}</DialogTitle>
        </DialogHeader>

        <div className="space-y-3 p-4">
          <p className="text-neutral-600 text-sm dark:text-neutral-400">
            将为选中的 {bookCount} 本书籍{mode === "add" ? "添加" : "移除"}以下标签：
          </p>

          {tags.length === 0 ? (
            <p className="py-4 text-center text-neutral-500 text-sm dark:text-neutral-400">暂无标签，请先创建标签</p>
          ) : (
            <div className="max-h-60 space-y-2 overflow-y-auto">
              {tags.map((tag) => (
                <div
                  key={tag.id}
                  className="flex cursor-pointer items-center gap-3 rounded-lg bg-muted p-2.5 transition-colors hover:bg-muted/70"
                  onClick={() => toggleTag(tag.id)}
                >
                  <Checkbox
                    checked={selectedTagIds.has(tag.id)}
                    onClick={(e) => e.stopPropagation()}
                    onCheckedChange={() => toggleTag(tag.id)}
                  />
                  <span className="flex-1 font-medium text-sm">{tag.name}</span>
                  {tag.color && <span className="h-3 w-3 rounded-full" style={{ backgroundColor: tag.color }} />}
                </div>
              ))}
            </div>
          )}
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose} disabled={isLoading}>
            取消
          </Button>
          <Button onClick={handleConfirm} disabled={selectedTagIds.size === 0 || isLoading}>
            {isLoading ? "应用中..." : `确定${mode === "add" ? "添加" : "移除"} (${selectedTagIds.size})`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
