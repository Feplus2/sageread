import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CURATED_FONTS, DEFAULT_BOOK_FONT } from "@/services/constants";
import {
  analyzeReaderBackground,
  listReaderBackgrounds,
  openReaderBackgroundsDir,
  preloadImages,
  resolveReaderBackgroundUrl,
} from "@/services/reader-background-service";
import { useAppSettingsStore } from "@/store/app-settings-store";
import { useFontStore } from "@/store/font-store";
import { useThemeStore } from "@/store/theme-store";
import { getReaderScene, readerScenes } from "@/styles/reader-scenes";
import { themes } from "@/styles/themes";
import { getMaxInlineSize } from "@/utils/config";
import { isCJKEnv } from "@/utils/misc";
import { getStyles } from "@/utils/style";
import { FolderOpen, RefreshCw, Settings2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MdCheck, MdOutlineDarkMode, MdOutlineLightMode } from "react-icons/md";
import { TbSunMoon } from "react-icons/tb";
import { toast } from "sonner";
import { FontSizeSlider } from "./font-size-slider";
import { useReaderStore, useReaderStoreApi } from "./reader-provider";

const FONT_SIZE_MIN = 12;
const FONT_SIZE_MAX = 32;
const FONT_SIZE_STEP = 2;

// 纯色背景预设：只保留"默认"（羊皮纸已升级为照片场景；sepia/parchment 的 palette 定义在 themes.ts 中保留）
const solidPresets = themes.filter((theme) => theme.name === "default");
const solidPresetLabels: Record<string, string> = {
  default: "默认",
};

const SettingsDropdown = () => {
  const store = useReaderStoreApi();
  const {
    themeMode,
    setThemeMode,
    themeColor,
    setThemeColor,
    themeCode,
    readerBackground,
    setReaderBackground,
    isDarkMode,
  } = useThemeStore();
  const [customBackgrounds, setCustomBackgrounds] = useState<string[]>([]);
  const [customBackgroundUrls, setCustomBackgroundUrls] = useState<Record<string, string>>({});

  // 取色器/滑块的本地草稿：拖动过程只更新本地态，停顿 200ms 才提交 store
  // （避免每帧写 localStorage 和触发书籍样式重注入）
  const [fgDraft, setFgDraft] = useState<string | null>(null);
  const [scrimDraft, setScrimDraft] = useState<number | null>(null);
  const commitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (commitTimerRef.current) clearTimeout(commitTimerRef.current);
    };
  }, []);

  // 扫描自定义背景图片（{appConfigDir}/reader-backgrounds）
  const refreshCustomBackgrounds = useCallback(async () => {
    const files = await listReaderBackgrounds();
    setCustomBackgrounds(files);
    const urls: Record<string, string> = {};
    for (const file of files) {
      urls[file] = await resolveReaderBackgroundUrl(file);
    }
    setCustomBackgroundUrls(urls);
    // 预加载场景与自定义图片（浏览器解码缓存），切换背景时不再现场解码
    preloadImages([...readerScenes.map((scene) => scene.uri), ...Object.values(urls)]);
  }, []);

  useEffect(() => {
    refreshCustomBackgrounds();
  }, [refreshCustomBackgrounds]);

  // 资产同步下载了新背景图后刷新列表
  useEffect(() => {
    const onUpdated = () => {
      refreshCustomBackgrounds();
    };
    window.addEventListener("reader-backgrounds-updated", onUpdated);
    return () => window.removeEventListener("reader-backgrounds-updated", onUpdated);
  }, [refreshCustomBackgrounds]);

  const handleSelectSolid = (name: string) => {
    setThemeColor(name);
    setReaderBackground({ kind: "solid", fg: readerBackground?.fg });
  };

  const handleSelectScene = (sceneId: string) => {
    setScrimDraft(null);
    setReaderBackground({ kind: "scene", sceneId, fg: readerBackground?.fg, scrim: readerBackground?.scrim });
  };

  const handleSelectCustom = async (fileName: string) => {
    const fileUrl = customBackgroundUrls[fileName] ?? (await resolveReaderBackgroundUrl(fileName));
    // 分析图片平均亮度，一次性算好明暗两套文字色与遮罩；失败静默保持现状
    const suggestion = await analyzeReaderBackground(fileName);
    setScrimDraft(null);
    setFgDraft(null);
    setReaderBackground({
      kind: "custom",
      fileName,
      fileUrl,
      fg: suggestion?.fg ?? readerBackground?.fg,
      scrim: suggestion?.scrim ?? readerBackground?.scrim,
      darkFg: suggestion?.darkFg ?? readerBackground?.darkFg,
      darkScrim: suggestion?.darkScrim ?? readerBackground?.darkScrim,
    });
  };

  const handleFgChange = (fg: string) => {
    setFgDraft(fg);
    if (commitTimerRef.current) clearTimeout(commitTimerRef.current);
    commitTimerRef.current = setTimeout(() => {
      const { readerBackground: current, setReaderBackground: apply, isDarkMode: dark } = useThemeStore.getState();
      const base = current ?? { kind: "solid" as const };
      // 取色器按当前明暗模式写入对应字段
      apply(dark ? { ...base, darkFg: fg } : { ...base, fg });
      setFgDraft(null);
    }, 200);
  };

  const handleResetFg = () => {
    setFgDraft(null);
    if (!readerBackground) return;
    const { fg: _fg, darkFg: _darkFg, ...rest } = readerBackground;
    setReaderBackground(rest);
  };

  const handleOpenBackgroundsFolder = async () => {
    try {
      await openReaderBackgroundsDir();
    } catch (error) {
      console.error("打开背景文件夹失败:", error);
      toast.error("打开背景文件夹失败", { description: String(error) });
    }
  };

  const activeScene = readerBackground?.kind === "scene" ? getReaderScene(readerBackground.sceneId) : undefined;
  const showScrimSlider = readerBackground?.kind === "scene" || readerBackground?.kind === "custom";
  // 滑块读写均按当前明暗模式取对应字段（darkXxx 缺省回落浅色值）
  const sceneDefaultScrim = activeScene ? (isDarkMode ? activeScene.dark.scrim : activeScene.light.scrim) : 0.55;
  const storedScrim = isDarkMode ? (readerBackground?.darkScrim ?? readerBackground?.scrim) : readerBackground?.scrim;
  const scrimPercent = scrimDraft ?? Math.round((storedScrim ?? sceneDefaultScrim) * 100);

  const handleScrimChange = (percent: number) => {
    setScrimDraft(percent);
    if (commitTimerRef.current) clearTimeout(commitTimerRef.current);
    commitTimerRef.current = setTimeout(() => {
      const { readerBackground: current, setReaderBackground: apply, isDarkMode: dark } = useThemeStore.getState();
      if (current) {
        apply(dark ? { ...current, darkScrim: percent / 100 } : { ...current, scrim: percent / 100 });
      }
      setScrimDraft(null);
    }, 200);
  };
  const { settings, setSettings } = useAppSettingsStore();
  const openDropdown = useReaderStore((state) => state.openDropdown);
  const setOpenDropdown = useReaderStore((state) => state.setOpenDropdown)!;
  const { fonts: customFontList, loadFonts } = useFontStore();

  const globalViewSettings = settings.globalViewSettings;
  const view = store.getState().view;
  const isSettingsDropdownOpen = openDropdown === "settings";

  const customFonts = useMemo(
    () =>
      customFontList.map((font) => {
        const fontFamily = font.fontFamily || font.name;
        return {
          id: `custom-${font.name}`,
          name: font.displayName || font.name,
          serif: fontFamily,
          sansSerif: fontFamily,
          cjk: fontFamily,
        };
      }),
    [customFontList],
  );

  const allFonts = useMemo(() => [...CURATED_FONTS, ...customFonts], [customFonts]);

  useEffect(() => {
    loadFonts();
  }, [loadFonts]);

  useEffect(() => {
    const currentFontExists = allFonts.some(
      (font) =>
        font.serif === globalViewSettings.serifFont &&
        font.sansSerif === globalViewSettings.sansSerifFont &&
        font.cjk === globalViewSettings.defaultCJKFont,
    );

    if (!currentFontExists && customFonts.length > 0) {
      const { settings: currentSettings } = useAppSettingsStore.getState();
      setSettings({
        ...currentSettings,
        globalViewSettings: {
          ...currentSettings.globalViewSettings,
          serifFont: DEFAULT_BOOK_FONT.serifFont,
          sansSerifFont: DEFAULT_BOOK_FONT.sansSerifFont,
          defaultCJKFont: DEFAULT_BOOK_FONT.defaultCJKFont,
        },
      });
    }
  }, [allFonts, customFonts.length, globalViewSettings, setSettings]);

  const currentFontId =
    allFonts.find(
      (font) =>
        font.serif === globalViewSettings.serifFont &&
        font.sansSerif === globalViewSettings.sansSerifFont &&
        font.cjk === globalViewSettings.defaultCJKFont,
    )?.id || "comfortable";

  const handleToggleSettingsDropdown = (isOpen: boolean) => {
    setOpenDropdown(isOpen ? "settings" : null);
  };

  const updateGlobalViewSettings = useCallback(
    (updater: (settings: typeof globalViewSettings) => typeof globalViewSettings) => {
      const { settings: currentSettings } = useAppSettingsStore.getState();
      const currentGlobalSettings = currentSettings.globalViewSettings;
      const updatedSettings = updater(currentGlobalSettings);
      setSettings({
        ...currentSettings,
        globalViewSettings: updatedSettings,
      });
      const currentView = store.getState().view;
      currentView?.renderer.setStyles?.(getStyles(updatedSettings));
      return updatedSettings;
    },
    [store, setSettings],
  );

  const applyScrolledMode = useCallback(
    (newScrolled: boolean) => {
      const updated = updateGlobalViewSettings((settings) => ({ ...settings, scrolled: newScrolled }));
      if (!view?.renderer) return;

      const applyNow = () => {
        if (view?.renderer) {
          const contents = view.renderer.getContents?.();
          const ready = Array.isArray(contents) && contents.length > 0 && contents[0]?.doc;
          if (!ready) {
            setTimeout(applyNow, 80);
            return;
          }
          view.renderer.setAttribute("flow", newScrolled ? "scrolled" : "paginated");
          view.renderer.setAttribute("max-inline-size", `${getMaxInlineSize(updated)}px`);
          view.renderer.setStyles?.(getStyles(updated));
        }
      };
      applyNow();
    },
    [updateGlobalViewSettings, view],
  );

  const handleFontSizeChange = useCallback(
    (newSize: number) => {
      const clampedSize = Math.max(FONT_SIZE_MIN, Math.min(FONT_SIZE_MAX, newSize));
      updateGlobalViewSettings((settings) => ({ ...settings, defaultFontSize: clampedSize }));
    },
    [updateGlobalViewSettings],
  );

  const handleFontChange = useCallback(
    (fontId: string) => {
      const selectedFont = allFonts.find((f) => f.id === fontId);
      if (!selectedFont) return;
      updateGlobalViewSettings((settings) => ({
        ...settings,
        serifFont: selectedFont.serif,
        sansSerifFont: selectedFont.sansSerif,
        defaultCJKFont: selectedFont.cjk,
      }));
    },
    [updateGlobalViewSettings, allFonts],
  );

  const handleIncrease = () => {
    handleFontSizeChange(globalViewSettings.defaultFontSize + FONT_SIZE_STEP);
  };

  const handleDecrease = () => {
    handleFontSizeChange(globalViewSettings.defaultFontSize - FONT_SIZE_STEP);
  };

  const isCJK = isCJKEnv();

  // 暂时注释掉分栏相关的函数和变量
  /*
  const handleSetColumnMode = useCallback(
    (mode: "auto" | "one" | "two") => {
      updateGlobalViewSettings((settings) => ({ ...settings, columnMode: mode }));
    },
    [updateGlobalViewSettings],
  );

  const currentColumnMode = globalViewSettings.columnMode;
  */

  return (
    <DropdownMenu open={isSettingsDropdownOpen} onOpenChange={handleToggleSettingsDropdown}>
      <DropdownMenuTrigger asChild>
        <button
          className="btn btn-ghost flex h-8 min-h-8 w-8 items-center justify-center rounded-full p-0 outline-none focus:outline-none focus-visible:ring-0"
          title="字体大小设置"
        >
          <Settings2 size={18} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-80 p-3" align="end" side="bottom" sideOffset={4}>
        <div className="space-y-4">
          <div>
            <div className="mb-3 font-medium text-sm">字体系列</div>
            {(() => {
              const selected = allFonts.find((f) => f.id === currentFontId);
              const triggerFontFamily = selected ? (isCJK ? selected.cjk : selected.serif) : undefined;
              const triggerFontWeight = selected?.id === "classic" ? "normal" : (undefined as any);
              return (
                <Select value={currentFontId} onValueChange={handleFontChange}>
                  <SelectTrigger
                    className="h-8 w-full focus:outline-none focus:ring-0"
                    style={{ fontFamily: triggerFontFamily, fontWeight: triggerFontWeight }}
                  >
                    <SelectValue placeholder="选择字体" />
                  </SelectTrigger>
                  <SelectContent className="w-full dark:border-neutral-700 dark:bg-neutral-800">
                    {allFonts.map((font) => (
                      <SelectItem key={font.id} value={font.id}>
                        <span
                          className="truncate"
                          style={{
                            fontFamily: isCJK ? font.cjk : font.serif,
                            fontWeight: font.id === "classic" ? "normal" : (undefined as any),
                          }}
                        >
                          {font.name}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              );
            })()}
          </div>

          <div>
            <div className="mb-3 font-medium text-sm">字体大小</div>
            <div className="flex items-center justify-center gap-4">
              <button
                className="btn btn-sm size-8 cursor-pointer rounded-md border bg-muted hover:bg-muted/70 disabled:bg-muted disabled:opacity-50"
                onClick={handleDecrease}
                disabled={globalViewSettings.defaultFontSize <= FONT_SIZE_MIN}
                title="减小字体大小"
              >
                <span className="flex items-center justify-center text-xs">A</span>
              </button>

              <FontSizeSlider
                value={[globalViewSettings.defaultFontSize]}
                onValueChange={(value: number[]) => handleFontSizeChange(value[0]!)}
                min={FONT_SIZE_MIN}
                max={FONT_SIZE_MAX}
                step={FONT_SIZE_STEP}
                showTooltip={true}
                tooltipContent={(value) => `${value}px`}
              />
              <button
                className="btn btn-sm size-8 cursor-pointer rounded-md border bg-muted hover:bg-muted/70 disabled:bg-muted disabled:opacity-50"
                onClick={handleIncrease}
                disabled={globalViewSettings.defaultFontSize >= FONT_SIZE_MAX}
                title="增大字体大小"
              >
                <span className="flex items-center justify-center text-lg">A</span>
              </button>
            </div>
          </div>

          <div>
            <div className="mb-3 font-medium text-sm">阅读模式</div>
            <div className="space-y-3">
              <div className="flex items-center gap-4">
                <button
                  className={`btn btn-sm flex h-8 flex-1 items-center justify-between rounded-md px-3 ${
                    globalViewSettings.scrolled
                      ? "border-none bg-primary text-primary-foreground hover:bg-primary/90"
                      : "border bg-muted text-primary hover:bg-muted/70"
                  }`}
                  onClick={() => applyScrolledMode(true)}
                  title="滚动模式"
                >
                  <span className="text-sm">滚动</span>
                  {globalViewSettings.scrolled && <MdCheck size={16} />}
                </button>
                <button
                  className={`btn btn-sm flex h-8 flex-1 items-center justify-between rounded-md px-3 ${
                    !globalViewSettings.scrolled
                      ? "border-none bg-primary text-primary-foreground hover:bg-primary/90"
                      : "border bg-muted text-primary hover:bg-muted/70"
                  }`}
                  onClick={() => applyScrolledMode(false)}
                  title="分页模式"
                >
                  <span className="text-sm">分页</span>
                  {!globalViewSettings.scrolled && <MdCheck size={16} />}
                </button>
              </div>
            </div>
          </div>

          <div>
            <div className="mb-3 font-medium text-sm">主题模式</div>
            <div className="flex items-center gap-4">
              <button
                className={`btn btn-sm flex size-8 items-center justify-center rounded-md ${
                  themeMode === "auto"
                    ? "border-none bg-primary text-primary-foreground hover:bg-primary/90"
                    : "border bg-muted text-primary hover:bg-muted/70"
                }`}
                onClick={() => setThemeMode("auto")}
                title="自动模式"
              >
                <TbSunMoon size={16} />
              </button>
              <button
                className={`btn btn-sm flex size-8 items-center justify-center rounded-md border ${
                  themeMode === "light"
                    ? "bg-primary text-primary-foreground hover:bg-primary/90"
                    : "bg-muted text-primary hover:bg-muted/70"
                }`}
                onClick={() => setThemeMode("light")}
                title="浅色模式"
              >
                <MdOutlineLightMode size={16} />
              </button>
              <button
                className={`btn btn-sm flex size-8 items-center justify-center rounded-md border ${
                  themeMode === "dark"
                    ? "bg-primary text-primary-foreground hover:bg-primary/90"
                    : "bg-muted text-primary hover:bg-muted/70"
                }`}
                onClick={() => setThemeMode("dark")}
                title="深色模式"
              >
                <MdOutlineDarkMode size={16} />
              </button>
            </div>
          </div>

          <div>
            <div className="mb-3 font-medium text-sm">配色</div>
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground text-xs">文字颜色</span>
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    value={fgDraft ?? themeCode.fg}
                    onChange={(e) => handleFgChange(e.target.value)}
                    className="h-7 w-10 cursor-pointer rounded-md border bg-transparent p-0.5"
                    title="自定义文字颜色"
                  />
                  <button
                    className="btn btn-sm rounded-md border bg-muted px-2 py-1 text-xs hover:bg-muted/70"
                    onClick={handleResetFg}
                    title="恢复为配色预设的文字颜色"
                  >
                    跟随主题
                  </button>
                </div>
              </div>

              <div>
                <div className="mb-1.5 text-muted-foreground text-xs">背景</div>
                <div className="grid grid-cols-3 gap-2">
                  {solidPresets.map((theme) => {
                    const palette = theme.colors.light;
                    const isSelected =
                      (!readerBackground || readerBackground.kind === "solid") && themeColor === theme.name;
                    return (
                      <button
                        key={theme.name}
                        title={solidPresetLabels[theme.name] ?? theme.label}
                        onClick={() => handleSelectSolid(theme.name)}
                        className={`btn btn-sm flex h-10 items-center justify-center rounded-md border ${
                          isSelected
                            ? "border-primary ring-2 ring-primary"
                            : "border-neutral-300 dark:border-neutral-600"
                        }`}
                        style={{ backgroundColor: palette["base-100"], color: palette["base-content"] }}
                      >
                        <span className="text-xs">A</span>
                      </button>
                    );
                  })}
                  {readerScenes.map((scene) => {
                    const isSelected = readerBackground?.kind === "scene" && readerBackground.sceneId === scene.id;
                    return (
                      <button
                        key={scene.id}
                        title={`${scene.label}${scene.mode === "dark" ? "（深色场景）" : ""}`}
                        onClick={() => handleSelectScene(scene.id)}
                        className={`btn btn-sm h-10 overflow-hidden rounded-md border p-0 ${
                          isSelected
                            ? "border-primary ring-2 ring-primary"
                            : "border-neutral-300 dark:border-neutral-600"
                        }`}
                      >
                        <img src={scene.uri} alt={scene.label} className="h-full w-full object-cover" />
                      </button>
                    );
                  })}
                </div>
              </div>

              <div>
                <div className="mb-1.5 flex items-center justify-between">
                  <span className="text-muted-foreground text-xs">自定义</span>
                  <div className="flex items-center gap-1">
                    <button
                      className="btn btn-sm flex size-6 items-center justify-center rounded-md border bg-muted hover:bg-muted/70"
                      title="打开背景文件夹"
                      onClick={handleOpenBackgroundsFolder}
                    >
                      <FolderOpen size={12} />
                    </button>
                    <button
                      className="btn btn-sm flex size-6 items-center justify-center rounded-md border bg-muted hover:bg-muted/70"
                      title="刷新"
                      onClick={refreshCustomBackgrounds}
                    >
                      <RefreshCw size={12} />
                    </button>
                  </div>
                </div>
                {customBackgrounds.length > 0 ? (
                  <div className="grid grid-cols-4 gap-2">
                    {customBackgrounds.map((fileName) => {
                      const isSelected = readerBackground?.kind === "custom" && readerBackground.fileName === fileName;
                      return (
                        <button
                          key={fileName}
                          title={fileName}
                          onClick={() => handleSelectCustom(fileName)}
                          className={`btn btn-sm h-10 overflow-hidden rounded-md border p-0 ${
                            isSelected
                              ? "border-primary ring-2 ring-primary"
                              : "border-neutral-300 dark:border-neutral-600"
                          }`}
                        >
                          <img
                            src={customBackgroundUrls[fileName]}
                            alt={fileName}
                            className="h-full w-full object-cover"
                          />
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <p className="text-muted-foreground text-xs">将图片放入背景文件夹后点刷新</p>
                )}
              </div>

              {showScrimSlider && (
                <div className="flex items-center gap-2">
                  <span className="flex-shrink-0 text-muted-foreground text-xs">遮罩浓度</span>
                  <input
                    type="range"
                    min={0}
                    max={95}
                    value={scrimPercent}
                    onChange={(e) => handleScrimChange(Number(e.target.value))}
                    className="h-1 flex-1 cursor-pointer"
                  />
                  <span className="w-9 text-right text-muted-foreground text-xs">{scrimPercent}%</span>
                </div>
              )}
            </div>
          </div>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

export default SettingsDropdown;
