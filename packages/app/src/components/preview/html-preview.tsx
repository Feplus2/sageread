import { buildHtmlSrcdoc } from "@/lib/preview-utils";
import { useThemeStore } from "@/store/theme-store";

interface HtmlPreviewProps {
  content: string;
}

export function HtmlPreview({ content }: HtmlPreviewProps) {
  const isDarkMode = useThemeStore((state) => state.isDarkMode);

  return (
    <iframe
      srcDoc={buildHtmlSrcdoc(content, isDarkMode)}
      sandbox="allow-scripts allow-modals"
      className="h-full w-full border-0 bg-white dark:bg-neutral-900"
      title="HTML Preview"
    />
  );
}
