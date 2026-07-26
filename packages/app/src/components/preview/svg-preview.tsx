import { buildSvgSrcdoc } from "@/lib/preview-utils";
import { useThemeStore } from "@/store/theme-store";

interface SvgPreviewProps {
  content: string;
}

export function SvgPreview({ content }: SvgPreviewProps) {
  const isDarkMode = useThemeStore((state) => state.isDarkMode);

  return (
    <iframe
      srcDoc={buildSvgSrcdoc(content, isDarkMode)}
      sandbox=""
      className="h-full w-full border-0 bg-white dark:bg-neutral-900"
      title="SVG Preview"
    />
  );
}
