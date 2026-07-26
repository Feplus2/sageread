import { useThemeStore } from "@/store/theme-store";
import { useEffect, useRef, useState } from "react";

interface MermaidPreviewProps {
  content: string;
}

export function MermaidPreview({ content }: MermaidPreviewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [svg, setSvg] = useState<string>("");
  const [error, setError] = useState<string>("");
  const isDarkMode = useThemeStore((state) => state.isDarkMode);

  useEffect(() => {
    let cancelled = false;

    async function render() {
      try {
        setError("");
        const mermaid = (await import("mermaid")).default;
        mermaid.initialize({
          startOnLoad: false,
          theme: isDarkMode ? "dark" : "default",
          securityLevel: "strict",
        });

        const id = `mermaid-${Date.now()}`;
        const { svg: renderedSvg } = await mermaid.render(id, content);

        if (!cancelled) {
          setSvg(renderedSvg);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Mermaid 渲染失败");
          setSvg("");
        }
      }
    }

    render();

    return () => {
      cancelled = true;
    };
  }, [content, isDarkMode]);

  if (error) {
    return (
      <div className="flex h-full flex-col gap-3 overflow-auto p-4">
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-red-700 text-sm dark:border-red-800 dark:bg-red-900/20 dark:text-red-300">
          {error}
        </div>
        <pre className="flex-1 overflow-auto rounded-lg bg-muted p-3 font-mono text-xs">{content}</pre>
      </div>
    );
  }

  if (!svg) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground text-sm">渲染中...</div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="flex h-full w-full items-center justify-center overflow-auto p-4 [&>svg]:max-h-full [&>svg]:max-w-full"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
