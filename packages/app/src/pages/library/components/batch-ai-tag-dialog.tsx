import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { AITagSuggestion, BookTagSuggestions } from "@/services/ai-tag-service";
import type { SimpleBook } from "@/types/simple-book";
import { Sparkles } from "lucide-react";
import { useEffect, useState } from "react";

export interface BatchAITagSelection {
  book: SimpleBook;
  tags: AITagSuggestion[];
}

interface BatchAITagDialogProps {
  isOpen: boolean;
  onClose: () => void;
  results: BookTagSuggestions[];
  onApply: (selections: BatchAITagSelection[]) => Promise<void>;
}

export default function BatchAITagDialog({ isOpen, onClose, results, onApply }: BatchAITagDialogProps) {
  // 每本书选中的标签名集合
  const [selectedMap, setSelectedMap] = useState<Record<string, Set<string>>>({});
  const [isLoading, setIsLoading] = useState(false);

  // 结果变化时默认全选
  useEffect(() => {
    if (isOpen) {
      const map: Record<string, Set<string>> = {};
      for (const r of results) {
        map[r.book.id] = new Set(r.suggestions.map((s) => s.name));
      }
      setSelectedMap(map);
    }
  }, [isOpen, results]);

  const toggleTag = (bookId: string, tagName: string) => {
    setSelectedMap((prev) => {
      const next = { ...prev };
      const set = new Set(next[bookId] ?? []);
      if (set.has(tagName)) {
        set.delete(tagName);
      } else {
        set.add(tagName);
      }
      next[bookId] = set;
      return next;
    });
  };

  const totalSelected = Object.values(selectedMap).reduce((acc, set) => acc + set.size, 0);

  const handleConfirm = async () => {
    const selections: BatchAITagSelection[] = [];
    for (const r of results) {
      const chosen = selectedMap[r.book.id];
      if (!chosen || chosen.size === 0) continue;
      const tags = r.suggestions.filter((s) => chosen.has(s.name));
      if (tags.length > 0) {
        selections.push({ book: r.book, tags });
      }
    }
    if (selections.length === 0) return;

    setIsLoading(true);
    try {
      await onApply(selections);
      onClose();
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[85vh] sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="size-5 text-primary" />
            AI 智能分类结果
          </DialogTitle>
        </DialogHeader>

        <div className="max-h-[60vh] space-y-4 overflow-y-auto p-4">
          {results.map((r) => (
            <div key={r.book.id} className="rounded-lg border p-3 dark:border-neutral-700">
              <div className="mb-2 flex items-center justify-between">
                <span className="font-medium text-sm">{r.book.title}</span>
                {r.error ? (
                  <Badge variant="secondary" className="text-xs text-red-500">
                    分类失败
                  </Badge>
                ) : (
                  <span className="text-neutral-500 text-xs dark:text-neutral-400">{r.suggestions.length} 个建议</span>
                )}
              </div>

              {r.error ? (
                <p className="text-neutral-500 text-xs dark:text-neutral-400">{r.error}</p>
              ) : (
                <div className="space-y-2">
                  {r.suggestions.map((s) => {
                    const checked = selectedMap[r.book.id]?.has(s.name) ?? false;
                    return (
                      <div
                        key={s.name}
                        className="flex cursor-pointer items-center gap-3 rounded-lg bg-muted p-2.5 transition-colors hover:bg-muted/70"
                        onClick={() => toggleTag(r.book.id, s.name)}
                      >
                        <Checkbox
                          checked={checked}
                          onClick={(e) => e.stopPropagation()}
                          onCheckedChange={() => toggleTag(r.book.id, s.name)}
                        />
                        <div className="flex-1 space-y-0.5">
                          <div className="flex items-center gap-2">
                            <span className="font-medium text-sm">{s.name}</span>
                            <Badge variant={s.isExisting ? "default" : "secondary"} className="text-xs">
                              {s.isExisting ? "现有标签" : "新标签"}
                            </Badge>
                          </div>
                          {s.reason && <p className="text-neutral-600 text-xs dark:text-neutral-400">{s.reason}</p>}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          ))}
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose} disabled={isLoading}>
            取消
          </Button>
          <Button onClick={handleConfirm} disabled={totalSelected === 0 || isLoading}>
            {isLoading ? "应用中..." : `确认添加 (${totalSelected})`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
