import { iframeService } from "@/services/iframe-service";
import { Transformer } from "markmap-lib";
import { Toolbar } from "markmap-toolbar";
import "markmap-toolbar/dist/style.css";
import { Markmap } from "markmap-view";
import { memo, useCallback, useEffect, useRef, useState } from "react";

interface MindmapViewerProps {
  markdown: string;
}

interface NodeMenuState {
  x: number;
  y: number;
  nodeText: string;
}

const MindmapViewerComponent = ({ markdown }: MindmapViewerProps) => {
  const svgRef = useRef<SVGSVGElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const markmapRef = useRef<Markmap | null>(null);
  const toolbarInstanceRef = useRef<Toolbar | null>(null);

  // 自定义节点右键菜单（markmap 节点为动态 SVG，无法用声明式 ContextMenu 包裹）
  const [nodeMenu, setNodeMenu] = useState<NodeMenuState | null>(null);

  const closeNodeMenu = useCallback(() => setNodeMenu(null), []);

  const handleAskAI = useCallback(() => {
    if (!nodeMenu) return;
    iframeService.sendAskAIRequest(nodeMenu.nodeText, `请解释：${nodeMenu.nodeText}`);
    closeNodeMenu();
  }, [nodeMenu, closeNodeMenu]);

  const handleCopyNode = useCallback(() => {
    if (!nodeMenu) return;
    navigator.clipboard.writeText(nodeMenu.nodeText);
    closeNodeMenu();
  }, [nodeMenu, closeNodeMenu]);

  // Esc 关闭菜单
  useEffect(() => {
    if (!nodeMenu) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeNodeMenu();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [nodeMenu, closeNodeMenu]);

  useEffect(() => {
    if (!svgRef.current || !markdown || !toolbarRef.current) return;

    const resizeObserver = new ResizeObserver(() => {
      if (markmapRef.current && svgRef.current) {
        const rect = svgRef.current.getBoundingClientRect();
        if (rect.width > 100) {
          markmapRef.current.fit();
        }
      }
    });

    if (svgRef.current.parentElement) {
      resizeObserver.observe(svgRef.current.parentElement);
    }

    const handleContextMenu = (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();

      const target = e.target as SVGElement;
      let nodeElement = target;

      while (nodeElement && nodeElement.nodeName !== "g") {
        nodeElement = nodeElement.parentElement as unknown as SVGElement;
      }

      if (!nodeElement || !nodeElement.classList.contains("markmap-node")) {
        return;
      }

      const textElement = nodeElement.querySelector("foreignObject")?.textContent;
      const nodeText = textElement?.trim() || "";

      if (!nodeText) return;

      setNodeMenu({ x: e.clientX, y: e.clientY, nodeText });
    };

    try {
      const transformer = new Transformer();
      const { root } = transformer.transform(markdown);

      if (!markmapRef.current) {
        markmapRef.current = Markmap.create(
          svgRef.current,
          {
            maxWidth: 320,
            paddingX: 16,
            spacingVertical: 12,
            spacingHorizontal: 100,
            autoFit: true,
            duration: 300,
            color: (node: any) => {
              const depth = node.state?.depth || 0;
              const colors = ["#5B8FF9", "#5AD8A6", "#5D7092", "#F6BD16", "#E8684A", "#6DC8EC", "#9270CA"];
              return colors[depth % colors.length];
            },
            nodeMinHeight: 36,
          },
          root,
        );

        if (!toolbarInstanceRef.current && toolbarRef.current) {
          while (toolbarRef.current.firstChild) {
            toolbarRef.current.removeChild(toolbarRef.current.firstChild);
          }

          const toolbar = new Toolbar();
          toolbar.attach(markmapRef.current);
          toolbar.setItems(["zoomIn", "zoomOut", "fit"]);
          toolbarRef.current.append(toolbar.render());
          toolbarInstanceRef.current = toolbar;
        }

        if (svgRef.current) {
          svgRef.current.addEventListener("contextmenu", handleContextMenu);
        }
      } else {
        markmapRef.current.setData(root);
        markmapRef.current.fit();
        markmapRef.current.rescale(1.2);
      }
    } catch (error) {
      console.error("Failed to render markmap:", error);
    }

    return () => {
      resizeObserver.disconnect();
      if (svgRef.current) {
        svgRef.current.removeEventListener("contextmenu", handleContextMenu);
      }
      if (toolbarInstanceRef.current) {
        toolbarInstanceRef.current = null;
      }
      if (markmapRef.current) {
        markmapRef.current.destroy();
        markmapRef.current = null;
      }
    };
  }, [markdown]);

  return (
    <div className="flex h-full w-full flex-col">
      <div className="relative flex-1 overflow-hidden px-4 py-2">
        <div ref={toolbarRef} className="absolute right-4 bottom-4 z-10" />
        <svg
          ref={svgRef}
          className="h-full w-full"
          style={{
            backgroundColor: "transparent",
          }}
        />
      </div>

      {nodeMenu && (
        <>
          {/* 透明遮罩：点击任意处关闭菜单 */}
          <div className="fixed inset-0 z-40" onClick={closeNodeMenu} onContextMenu={(e) => e.preventDefault()} />
          <div
            className="bg-popover text-popover-foreground fixed z-50 min-w-40 overflow-hidden rounded-md border p-1 shadow-md"
            style={{ left: nodeMenu.x, top: nodeMenu.y }}
          >
            <button
              type="button"
              onClick={handleAskAI}
              className="focus:bg-accent focus:text-accent-foreground flex w-full cursor-default items-center rounded-sm px-2 py-1.5 text-left text-sm outline-hidden select-none"
            >
              询问 AI 关于“{nodeMenu.nodeText.slice(0, 20)}
              {nodeMenu.nodeText.length > 20 ? "..." : ""}”
            </button>
            <button
              type="button"
              onClick={handleCopyNode}
              className="focus:bg-accent focus:text-accent-foreground flex w-full cursor-default items-center rounded-sm px-2 py-1.5 text-left text-sm outline-hidden select-none"
            >
              复制节点内容
            </button>
          </div>
        </>
      )}
    </div>
  );
};

export const MindmapViewer = memo(MindmapViewerComponent);
