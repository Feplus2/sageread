/**
 * 用户翻页活动追踪（进程内单例）：
 * 供同步落地时做"防跳动保护"——60 秒内用户刚翻过页的书不自动跳转位置。
 */
const lastNavigationAt = new Map<string, number>();

/** 记录一次用户翻页（位置变化时调用） */
export function markUserNavigation(bookId: string): void {
  lastNavigationAt.set(bookId, Date.now());
}

/** 距上次用户翻页的毫秒数；从未翻过返回 Infinity */
export function msSinceUserNavigation(bookId: string): number {
  const at = lastNavigationAt.get(bookId);
  return at === undefined ? Number.POSITIVE_INFINITY : Date.now() - at;
}

/** 程序化跳转（同步落地 goTo）时间戳：该时间窗内的位置变化不算用户翻页 */
const programmaticNavigationAt = new Map<string, number>();
const PROGRAMMATIC_WINDOW_MS = 2_000;

/** 标记一次程序化跳转（goTo 前调用） */
export function markProgrammaticNavigation(bookId: string): void {
  programmaticNavigationAt.set(bookId, Date.now());
}

/** 当前是否处于程序化跳转时间窗内 */
export function isProgrammaticNavigation(bookId: string): boolean {
  const at = programmaticNavigationAt.get(bookId);
  return at !== undefined && Date.now() - at < PROGRAMMATIC_WINDOW_MS;
}
