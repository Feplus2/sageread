import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useConverterStore } from "@/store/converter-store";

export default function ConverterSettings() {
  const { mineruToken, setMineruToken } = useConverterStore();

  return (
    <div className="space-y-6 p-4">
      <div className="space-y-2">
        <h2 className="font-semibold text-lg dark:text-neutral-100">PDF 转换</h2>
        <p className="text-neutral-600 text-sm dark:text-neutral-400">
          PDF 转 EPUB 由 Books_Converter 引擎驱动（MinerU 云端解析 + 辅助模型结构重建）。
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="mineru-token">MinerU Token</Label>
        <Input
          id="mineru-token"
          type="password"
          value={mineruToken}
          onChange={(e) => setMineruToken(e.target.value)}
          placeholder="在 mineru.net 申请"
        />
        <p className="text-neutral-500 text-xs dark:text-neutral-500">
          Token 仅保存在本机（converter-store.json），不会随备份/同步上传。 转换所需的 LLM
          配置自动复用「模型提供商」中的辅助模型（需为 OpenAI 兼容端点，如 DeepSeek / OpenAI / OpenRouter）。
        </p>
      </div>
    </div>
  );
}
