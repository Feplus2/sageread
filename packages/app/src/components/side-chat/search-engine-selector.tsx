import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { type SearchEngine, useWebSearchStore } from "@/store/web-search-store";
import { Check, Globe } from "lucide-react";

const ENGINE_OPTIONS: { value: SearchEngine; label: string }[] = [
  { value: "auto", label: "自动" },
  { value: "bing", label: "必应" },
  { value: "baidu", label: "百度" },
  { value: "duckduckgo", label: "DuckDuckGo" },
];

/** 网络搜索引擎选择器（置于聊天输入框旁） */
export function SearchEngineSelector() {
  const { engine, setEngine } = useWebSearchStore();
  const currentLabel = ENGINE_OPTIONS.find((o) => o.value === engine)?.label ?? "自动";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          title="选择网络搜索引擎"
          className="flex h-8 cursor-pointer items-center gap-1 rounded-full border border-neutral-200 px-2 text-neutral-600 transition-colors hover:bg-neutral-100 dark:border-neutral-600 dark:text-neutral-300 dark:hover:bg-neutral-700"
        >
          <Globe className="size-4" />
          <span className="text-xs">{currentLabel}</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-32">
        {ENGINE_OPTIONS.map((option) => (
          <DropdownMenuItem key={option.value} onClick={() => setEngine(option.value)}>
            <span className="flex-1">{option.label}</span>
            {engine === option.value && <Check className="size-4" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
