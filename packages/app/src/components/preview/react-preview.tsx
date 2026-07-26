import { useThemeStore } from "@/store/theme-store";
import { SandpackPreview, SandpackProvider } from "@codesandbox/sandpack-react";

interface ReactPreviewProps {
  content: string;
  language: string;
}

export function ReactPreview({ content, language }: ReactPreviewProps) {
  const isDarkMode = useThemeStore((state) => state.isDarkMode);
  const isTs = language === "tsx" || language === "typescript";
  const template = isTs ? "react-ts" : "react";
  const fileName = isTs ? "/App.tsx" : "/App.js";

  return (
    <div className="h-full w-full">
      <SandpackProvider
        template={template}
        files={{ [fileName]: content }}
        theme={isDarkMode ? "dark" : "light"}
        options={{
          externalResources: [],
        }}
      >
        <SandpackPreview showOpenInCodeSandbox={false} showRefreshButton />
      </SandpackProvider>
    </div>
  );
}
