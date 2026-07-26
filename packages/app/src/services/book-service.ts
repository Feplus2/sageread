import { DocumentLoader } from "@/lib/document";
import type {
  BookQueryOptions,
  BookStatus,
  BookStatusUpdateData,
  BookUpdateData,
  BookUploadData,
  BookVectorizationMeta,
  BookWithStatus,
  BookWithStatusAndUrls,
  SimpleBook,
} from "@/types/simple-book";

export interface TocNode {
  id: string;
  play_order: number;
  title: string;
  src: string;
  children: TocNode[];
}
import { formatAuthors, formatTitle, getPrimaryLanguage } from "@/utils/book";
import { partialMD5 } from "@/utils/md5";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { appDataDir, tempDir } from "@tauri-apps/api/path";
import { join } from "@tauri-apps/api/path";
import { writeFile, readFile } from "@tauri-apps/plugin-fs";

export async function uploadBook(file: File): Promise<SimpleBook> {
  try {
    const format = getBookFormat(file.name);
    if (!["EPUB", "PDF", "MOBI", "CBZ", "FB2", "FBZ"].includes(format)) {
      throw new Error(`不支持的文件格式: ${format}`);
    }

    const bookHash = await partialMD5(file);
    const tempDirPath = await tempDir();
    const tempFileName = `temp_${bookHash}.${format.toLowerCase()}`;
    const tempFilePath = await join(tempDirPath, tempFileName);
    const fileData = await file.arrayBuffer();
    await writeFile(tempFilePath, new Uint8Array(fileData));
    const metadata = await extractMetadataOnly(file);

    let coverTempFilePath: string | undefined;
    if (format === "EPUB") {
      const coverBlob = await extractCoverBlob(fileData, file.name);
      if (coverBlob) {
        const coverTempFileName = `cover_${bookHash}.jpg`;
        const coverTempPath = await join(tempDirPath, coverTempFileName);
        const coverArrayBuffer = await coverBlob.arrayBuffer();
        await writeFile(coverTempPath, new Uint8Array(coverArrayBuffer));
        coverTempFilePath = coverTempPath;
      }
    }

    const uploadData: BookUploadData = {
      id: bookHash,
      title: formatTitle(metadata.title) || getFileNameWithoutExt(file.name),
      author: formatAuthors(metadata.author) || "Unknown",
      format,
      fileSize: file.size,
      language: getPrimaryLanguage(metadata.language) || "en",
      tempFilePath: tempFilePath,
      coverTempFilePath,
      metadata: metadata,
    };

    const result = await invoke<SimpleBook>("save_book", { data: uploadData });
    return result;
  } catch (error) {
    console.error("书籍上传失败:", error);
    throw new Error(`上传失败: ${error instanceof Error ? error.message : "未知错误"}`);
  }
}

async function extractMetadataOnly(file: File): Promise<any> {
  try {
    if (file.name.toLowerCase().endsWith(".epub")) {
      const arrayBuffer = await file.arrayBuffer();
      const bookDoc = await parseEpubFile(arrayBuffer, file.name);
      return bookDoc.metadata;
    }

    return {
      title: getFileNameWithoutExt(file.name),
      author: "Unknown",
      language: "en",
    };
  } catch (error) {
    console.warn("元数据提取失败，使用默认值:", error);
    return {
      title: getFileNameWithoutExt(file.name),
      author: "Unknown",
      language: "en",
    };
  }
}

/** 从 EPUB 数据提取封面 Blob（导入/下载重建共用；失败返回 null 不抛出） */
export async function extractCoverBlob(fileData: ArrayBuffer, fileName: string): Promise<Blob | null> {
  try {
    const bookDoc = await parseEpubFile(fileData, fileName);
    return await bookDoc.getCover();
  } catch (e) {
    console.warn("无法提取封面:", e);
    return null;
  }
}

/**
 * 云端下载后重建封面：解析书文件提取封面，写入 books/<id>/cover.jpg（与 save_book 同款落位，
 * cover_path 已随元数据同步指向此处）。返回相对路径；提取失败返回 undefined（不阻塞打开）。
 */
export async function rebuildCoverAfterDownload(bookId: string, format: string): Promise<string | undefined> {
  if (format.toUpperCase() !== "EPUB") return undefined;
  try {
    const base = await appDataDir();
    const bookFilePath = `${base}/books/${bookId}/book.${format.toLowerCase()}`;
    const fileData = await readFile(bookFilePath);
    const coverBlob = await extractCoverBlob(fileData.buffer as ArrayBuffer, bookFilePath);
    if (!coverBlob) return undefined;

    const coverRelPath = `books/${bookId}/cover.jpg`;
    await writeFile(`${base}/${coverRelPath}`, new Uint8Array(await coverBlob.arrayBuffer()));
    return coverRelPath;
  } catch (e) {
    console.warn("下载后重建封面失败（忽略）:", e);
    return undefined;
  }
}

export async function getBooks(options: BookQueryOptions = {}): Promise<SimpleBook[]> {
  try {
    const result = await invoke<SimpleBook[]>("get_books", { options });
    return result;
  } catch (error) {
    console.error("获取书籍列表失败:", error);
    throw new Error(`获取书籍列表失败: ${error instanceof Error ? error.message : "未知错误"}`);
  }
}

export async function getBookById(id: string): Promise<SimpleBook | null> {
  try {
    const result = await invoke<SimpleBook | null>("get_book_by_id", { id });
    return result;
  } catch (error) {
    console.error("获取书籍详情失败:", error);
    throw new Error(`获取书籍详情失败: ${error instanceof Error ? error.message : "未知错误"}`);
  }
}

export async function convertBookWithStatusUrls(book: BookWithStatus): Promise<BookWithStatusAndUrls> {
  try {
    const appDataDirPath = await appDataDir();
    const absoluteFilePath = book.filePath.startsWith("/") ? book.filePath : `${appDataDirPath}/${book.filePath}`;

    const absoluteCoverPath = book.coverPath
      ? book.coverPath.startsWith("/")
        ? book.coverPath
        : `${appDataDirPath}/${book.coverPath}`
      : undefined;

    const fileUrl = convertFileSrc(absoluteFilePath);
    const coverUrl = absoluteCoverPath ? convertFileSrc(absoluteCoverPath) : undefined;

    return {
      ...book,
      fileUrl,
      coverUrl,
    };
  } catch (error) {
    console.error("Error converting book URLs for:", book.title, error);
    throw error;
  }
}

export async function getBookWithStatusById(id: string): Promise<BookWithStatusAndUrls | null> {
  try {
    const bookWithStatus = await invoke<BookWithStatus | null>("get_book_with_status_by_id", { id });
    if (!bookWithStatus) return null;

    return await convertBookWithStatusUrls(bookWithStatus);
  } catch (error) {
    console.error("获取书籍详情失败:", error);
    throw new Error(`获取书籍详情失败: ${error instanceof Error ? error.message : "未知错误"}`);
  }
}

export async function updateBook(id: string, updateData: BookUpdateData): Promise<SimpleBook> {
  try {
    const result = await invoke<SimpleBook>("update_book", {
      id,
      updateData: {
        ...updateData,
        updatedAt: Date.now(),
      },
    });
    return result;
  } catch (error) {
    console.error("更新书籍失败:", error);
    throw new Error(`更新书籍失败: ${error instanceof Error ? error.message : "未知错误"}`);
  }
}

export async function deleteBook(id: string): Promise<void> {
  try {
    await invoke("delete_book", { id });
  } catch (error) {
    console.error("删除书籍失败:", error);
    throw new Error(`删除书籍失败: ${error instanceof Error ? error.message : "未知错误"}`);
  }
}

/** 从回收站恢复书籍 */
export async function restoreBook(id: string): Promise<void> {
  try {
    await invoke("restore_book", { id });
  } catch (error) {
    console.error("恢复书籍失败:", error);
    throw new Error(`恢复书籍失败: ${error instanceof Error ? error.message : "未知错误"}`);
  }
}

/** 回收站列表（按删除时间倒序） */
export async function getTrashedBooks(): Promise<SimpleBook[]> {
  try {
    const result = await invoke<SimpleBook[]>("get_trashed_books");
    return result;
  } catch (error) {
    console.error("获取回收站失败:", error);
    throw new Error(`获取回收站失败: ${error instanceof Error ? error.message : "未知错误"}`);
  }
}

/** 彻底删除（删磁盘文件与全部关联数据，不可恢复） */
export async function purgeBook(id: string): Promise<void> {
  try {
    await invoke("purge_book", { id });
  } catch (error) {
    console.error("彻底删除书籍失败:", error);
    throw new Error(`彻底删除书籍失败: ${error instanceof Error ? error.message : "未知错误"}`);
  }
}

export async function searchBooks(
  query: string,
  options: Omit<BookQueryOptions, "searchQuery"> = {},
): Promise<SimpleBook[]> {
  try {
    const searchOptions: BookQueryOptions = {
      ...options,
      searchQuery: query,
    };
    return await getBooks(searchOptions);
  } catch (error) {
    console.error("搜索书籍失败:", error);
    throw new Error(`搜索失败: ${error instanceof Error ? error.message : "未知错误"}`);
  }
}

export async function getBookStatus(bookId: string): Promise<BookStatus | null> {
  try {
    const result = await invoke<BookStatus | null>("get_book_status", { bookId });
    return result;
  } catch (error) {
    console.error("获取书籍状态失败:", error);
    throw new Error(`获取书籍状态失败: ${error instanceof Error ? error.message : "未知错误"}`);
  }
}

export async function updateBookStatus(bookId: string, updateData: BookStatusUpdateData): Promise<BookStatus> {
  try {
    const result = await invoke<BookStatus>("update_book_status", { bookId, updateData });
    return result;
  } catch (error) {
    console.error("更新书籍状态失败:", error);
    throw new Error(`更新书籍状态失败: ${error instanceof Error ? error.message : "未知错误"}`);
  }
}

export async function getBooksWithStatus(options: BookQueryOptions = {}): Promise<BookWithStatus[]> {
  try {
    const result = await invoke<BookWithStatus[]>("get_books_with_status", { options });
    return result;
  } catch (error) {
    console.error("获取书籍列表失败:", error);
    throw new Error(`获取书籍列表失败: ${error instanceof Error ? error.message : "未知错误"}`);
  }
}

// 默认的获取书籍函数，包含状态信息
export const getLibraryBooks = getBooksWithStatus;

export async function updateBookProgress(
  bookId: string,
  current: number,
  total: number,
  location?: string,
): Promise<BookStatus> {
  return updateBookStatus(bookId, {
    progressCurrent: current,
    progressTotal: total,
    location: location || "",
    lastReadAt: Date.now(),
  });
}

export interface EpubIndexReport {
  db_path: string;
  book_title: string;
  book_author: string;
  total_chunks: number;
  vector_dimension: number;
}

export interface EpubIndexResult {
  success: boolean;
  message: string;
  report?: EpubIndexReport;
}

export async function indexEpub(
  bookId: string,
  params: { dimension?: number; embeddingsUrl?: string; model?: string; apiKey?: string | null },
): Promise<EpubIndexResult> {
  const { dimension = 1024, embeddingsUrl, model = "local-embed", apiKey = null } = params;

  const res = await invoke<EpubIndexResult>("plugin:epub|index_epub", {
    bookId,
    dimension,
    embeddingsUrl,
    model,
    apiKey,
  });
  return res;
}

export async function convertBookToMdbook(bookId: string, overwrite = true): Promise<{ outputDir: string }> {
  const res = await invoke<{ success: boolean; message: string; outputDir?: string }>("plugin:epub|convert_to_mdbook", {
    bookId,
    overwrite,
  });
  if (!res?.success || !res.outputDir) {
    throw new Error(res?.message || "转换失败");
  }
  return { outputDir: res.outputDir };
}

// 解析 TOC 目录结构
export async function parseToc(bookId: string): Promise<TocNode[]> {
  console.log("parseToc: bookId=", bookId);
  try {
    const tocNodes = await invoke<TocNode[]>("plugin:epub|parse_toc", {
      bookId,
    });
    return tocNodes;
  } catch (error) {
    console.log("解析 TOC 失败:", error);
    throw new Error(error instanceof Error ? error.message : "解析 TOC 失败");
  }
}

// Merge-update vectorization metadata without clobbering other metadata fields
export async function updateBookVectorizationMeta(
  bookId: string,
  patch: Partial<BookVectorizationMeta>,
): Promise<BookStatus> {
  const current = await getBookStatus(bookId);
  const prevVec = current?.metadata?.vectorization ?? {};
  const nextVec: BookVectorizationMeta = {
    // Defaults if creating from scratch
    status: "idle",
    model: "",
    dimension: 0,
    chunkCount: 0,
    version: 1,
    ...prevVec,
    ...patch,
    updatedAt: Date.now(),
  } as BookVectorizationMeta;

  const newMetadata = {
    ...(current?.metadata ?? {}),
    vectorization: nextVec,
  } as BookStatus["metadata"];

  return updateBookStatus(bookId, { metadata: newMetadata });
}

async function parseEpubFile(fileData: ArrayBuffer, fileName: string) {
  const file = new File([fileData], fileName, {
    type: getFileMimeType(fileName),
  });
  const loader = new DocumentLoader(file);
  const { book } = await loader.open();
  return book;
}

function getBookFormat(fileName: string): SimpleBook["format"] {
  const ext = fileName.toLowerCase().split(".").pop();
  switch (ext) {
    case "epub":
      return "EPUB";
    case "pdf":
      return "PDF";
    case "mobi":
      return "MOBI";
    case "cbz":
      return "CBZ";
    case "fb2":
      return "FB2";
    case "fbz":
      return "FBZ";
    default:
      return "EPUB";
  }
}

function getFileMimeType(fileName: string): string {
  const ext = fileName.toLowerCase().split(".").pop();
  switch (ext) {
    case "epub":
      return "application/epub+zip";
    case "pdf":
      return "application/pdf";
    case "mobi":
      return "application/x-mobipocket-ebook";
    case "cbz":
      return "application/vnd.comicbook+zip";
    case "fb2":
      return "application/x-fictionbook+xml";
    case "fbz":
      return "application/x-zip-compressed-fb2";
    default:
      return "application/octet-stream";
  }
}

function getFileNameWithoutExt(fileName: string): string {
  return fileName.replace(/\.[^/.]+$/, "");
}
