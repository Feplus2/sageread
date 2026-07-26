import { getExtensionForLanguage } from "@/lib/preview-utils";
import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import { toast } from "sonner";

/**
 * 将代码块内容导出为文件
 */
export async function exportCodeBlock(content: string, language: string, title?: string): Promise<boolean> {
  try {
    const ext = getExtensionForLanguage(language);
    const defaultName = title || `code-block.${ext}`;
    const safeName = defaultName.replace(/[<>:"/\\|?*]/g, "_");

    const path = await save({
      defaultPath: safeName.endsWith(`.${ext}`) ? safeName : `${safeName}.${ext}`,
      filters: [
        {
          name: ext.toUpperCase(),
          extensions: [ext],
        },
      ],
    });

    if (!path) {
      return false;
    }

    await writeTextFile(path, content);
    toast.success("代码导出成功");
    return true;
  } catch (error) {
    console.error("导出代码块失败:", error);
    toast.error("导出代码块失败");
    return false;
  }
}
